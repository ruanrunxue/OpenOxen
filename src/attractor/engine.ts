import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { evaluateCondition } from "./condition.ts";
import { PipelineContext } from "./context.ts";
import {
  CodergenHandler,
  ConditionalHandler,
  ExitHandler,
  FanInHandler,
  HandlerRegistry,
  ManagerLoopHandler,
  ParallelHandler,
  StartHandler,
  ToolHandler,
  WaitForHumanHandler,
  normalizeLabel,
  type CodergenBackend,
} from "./handlers.ts";
import { AutoApproveInterviewer, type Interviewer } from "./interviewer.ts";
import {
  asBoolean,
  asNumber,
  asString,
  type Checkpoint,
  type EdgeSpec,
  type GraphSpec,
  type NodeSpec,
  type Outcome,
} from "./model.ts";
import { validateOrRaise } from "./validator.ts";

export interface AttractorRuntime {
  registry: HandlerRegistry;
}

export interface PipelineRunOptions {
  logsRoot: string;
  runtime?: AttractorRuntime;
  context?: PipelineContext;
  resume?: boolean;
}

export interface PipelineRunResult {
  status: "success" | "fail";
  completedNodes: string[];
  nodeOutcomes: Record<string, Outcome>;
  context: Record<string, unknown>;
  logsRoot: string;
}

export function createDefaultRuntime(args?: {
  codergenBackend?: CodergenBackend;
  interviewer?: Interviewer;
}): AttractorRuntime {
  const codergen = new CodergenHandler(args?.codergenBackend);
  const registry = new HandlerRegistry(codergen);
  registry.register("start", new StartHandler());
  registry.register("exit", new ExitHandler());
  registry.register("codergen", codergen);
  registry.register("wait.human", new WaitForHumanHandler(args?.interviewer ?? new AutoApproveInterviewer()));
  registry.register("conditional", new ConditionalHandler());
  registry.register("parallel", new ParallelHandler());
  registry.register("parallel.fan_in", new FanInHandler());
  registry.register("tool", new ToolHandler());
  registry.register("stack.manager_loop", new ManagerLoopHandler());
  return { registry };
}

function startNode(graph: GraphSpec): NodeSpec {
  const starts = [...graph.nodes.values()].filter(
    (n) => n.attrs.shape === "Mdiamond" || n.id === "start" || n.id === "Start",
  );
  if (starts.length !== 1) {
    throw new Error(`Expected exactly one start node, got ${starts.length}`);
  }
  return starts[0]!;
}

function isTerminal(node: NodeSpec): boolean {
  return node.attrs.shape === "Msquare";
}

function edgeWeight(edge: EdgeSpec): number {
  return asNumber(edge.attrs.weight, 0);
}

function bestByWeightThenLexical(edges: EdgeSpec[]): EdgeSpec | undefined {
  if (!edges.length) {
    return undefined;
  }
  return [...edges].sort((a, b) => {
    const weightDiff = edgeWeight(b) - edgeWeight(a);
    if (weightDiff !== 0) {
      return weightDiff;
    }
    return a.to.localeCompare(b.to);
  })[0];
}

function selectEdge(node: NodeSpec, outcome: Outcome, context: PipelineContext, graph: GraphSpec): EdgeSpec | undefined {
  const edges = graph.edges.filter((e) => e.from === node.id);
  if (!edges.length) {
    return undefined;
  }
  const conditionMatched = edges.filter((edge) => {
    const condition = asString(edge.attrs.condition, "").trim();
    return condition ? evaluateCondition(condition, outcome, context.snapshot()) : false;
  });
  if (conditionMatched.length) {
    return bestByWeightThenLexical(conditionMatched);
  }

  if (outcome.preferred_label) {
    const preferred = normalizeLabel(outcome.preferred_label);
    const byLabel = edges.find((e) => normalizeLabel(asString(e.attrs.label, "")) === preferred);
    if (byLabel) {
      return byLabel;
    }
  }

  const suggested = outcome.suggested_next_ids ?? [];
  for (const id of suggested) {
    const found = edges.find((e) => e.to === id);
    if (found) {
      return found;
    }
  }

  const unconditional = edges.filter((e) => !asString(e.attrs.condition, "").trim());
  if (unconditional.length) {
    return bestByWeightThenLexical(unconditional);
  }
  return undefined;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function statusNorm(status: string | undefined): Outcome["status"] {
  const normalized = String(status ?? "success").toLowerCase();
  if (normalized === "success" || normalized === "fail" || normalized === "retry") {
    return normalized;
  }
  if (normalized === "partial_success" || normalized === "partial-success") {
    return "partial_success";
  }
  if (normalized === "skipped") {
    return "skipped";
  }
  return "success";
}

async function executeWithRetry(
  node: NodeSpec,
  graph: GraphSpec,
  runtime: AttractorRuntime,
  context: PipelineContext,
  logsRoot: string,
  retryCounter: Record<string, number>,
): Promise<Outcome> {
  const maxRetries = asNumber(node.attrs.max_retries, asNumber(graph.attrs.default_max_retry, 0));
  const maxAttempts = Math.max(1, maxRetries + 1);
  const initialDelay = asNumber(graph.attrs.initial_delay_ms, 1);
  const factor = asNumber(graph.attrs.backoff_factor, 2);
  const maxDelay = asNumber(graph.attrs.max_delay_ms, 1000);
  const jitter = asBoolean(graph.attrs.backoff_jitter, false);

  let last: Outcome = { status: "fail", failure_reason: "unknown" };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const handler = runtime.registry.resolve(node);
      const raw = await handler.execute({ node, graph, context, logsRoot });
      const outcome: Outcome = {
        ...raw,
        status: statusNorm(raw.status),
        context_updates: raw.context_updates ?? {},
      };
      last = outcome;
      if (outcome.status === "success" || outcome.status === "partial_success") {
        retryCounter[node.id] = 0;
        return outcome;
      }
      if (outcome.status === "retry" || outcome.status === "fail") {
        if (attempt < maxAttempts) {
          retryCounter[node.id] = (retryCounter[node.id] ?? 0) + 1;
          let delay = Math.min(initialDelay * Math.pow(factor, attempt - 1), maxDelay);
          if (jitter) {
            delay = delay * (0.5 + Math.random());
          }
          await sleep(delay);
          continue;
        }
        if (asBoolean(node.attrs.allow_partial, false)) {
          return { status: "partial_success", notes: "retries exhausted, partial accepted" };
        }
        return outcome;
      }
      return outcome;
    } catch (error) {
      last = { status: "fail", failure_reason: String(error) };
      if (attempt < maxAttempts) {
        retryCounter[node.id] = (retryCounter[node.id] ?? 0) + 1;
        await sleep(1);
        continue;
      }
    }
  }
  return last;
}

function getRetryTargetForNode(node: NodeSpec, graph: GraphSpec): string | undefined {
  const direct = asString(node.attrs.retry_target, "").trim();
  if (direct && graph.nodes.has(direct)) {
    return direct;
  }
  const fallback = asString(node.attrs.fallback_retry_target, "").trim();
  if (fallback && graph.nodes.has(fallback)) {
    return fallback;
  }
  const graphRetry = asString(graph.attrs.retry_target, "").trim();
  if (graphRetry && graph.nodes.has(graphRetry)) {
    return graphRetry;
  }
  const graphFallback = asString(graph.attrs.fallback_retry_target, "").trim();
  if (graphFallback && graph.nodes.has(graphFallback)) {
    return graphFallback;
  }
  return undefined;
}

function goalGateSatisfied(graph: GraphSpec, nodeOutcomes: Record<string, Outcome>): [boolean, NodeSpec | undefined] {
  for (const node of graph.nodes.values()) {
    if (!asBoolean(node.attrs.goal_gate, false)) {
      continue;
    }
    const outcome = nodeOutcomes[node.id];
    if (!outcome) {
      return [false, node];
    }
    if (!(outcome.status === "success" || outcome.status === "partial_success")) {
      return [false, node];
    }
  }
  return [true, undefined];
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

async function writeNodeStatus(logsRoot: string, nodeId: string, outcome: Outcome): Promise<void> {
  await writeJson(join(logsRoot, nodeId, "status.json"), outcome);
}

async function saveCheckpoint(
  logsRoot: string,
  currentNode: string,
  completedNodes: string[],
  retryCounter: Record<string, number>,
  context: PipelineContext,
): Promise<void> {
  const checkpoint: Checkpoint = {
    timestamp: new Date().toISOString(),
    current_node: currentNode,
    completed_nodes: completedNodes,
    node_retries: retryCounter,
    context_values: context.snapshot(),
  };
  await writeJson(join(logsRoot, "checkpoint.json"), checkpoint);
}

async function loadCheckpoint(logsRoot: string): Promise<Checkpoint | undefined> {
  try {
    const raw = await readFile(join(logsRoot, "checkpoint.json"), "utf8");
    return JSON.parse(raw) as Checkpoint;
  } catch {
    return undefined;
  }
}

export async function runPipeline(graph: GraphSpec, options: PipelineRunOptions): Promise<PipelineRunResult> {
  validateOrRaise(graph);
  const runtime = options.runtime ?? createDefaultRuntime();
  const logsRoot = options.logsRoot;
  await mkdir(logsRoot, { recursive: true });
  await writeJson(join(logsRoot, "manifest.json"), {
    graph_id: graph.id,
    goal: asString(graph.attrs.goal, ""),
    started_at: new Date().toISOString(),
  });

  const context = options.context ?? new PipelineContext();
  for (const [key, value] of Object.entries(graph.attrs)) {
    context.set(`graph.${key}`, value);
  }

  const nodeOutcomes: Record<string, Outcome> = {};
  const completedNodes: string[] = [];
  const retryCounter: Record<string, number> = {};

  let currentId = startNode(graph).id;
  if (options.resume) {
    const checkpoint = await loadCheckpoint(logsRoot);
    if (checkpoint) {
      currentId = checkpoint.current_node;
      for (const [key, value] of Object.entries(checkpoint.context_values ?? {})) {
        context.set(key, value);
      }
      for (const id of checkpoint.completed_nodes ?? []) {
        completedNodes.push(id);
      }
      Object.assign(retryCounter, checkpoint.node_retries ?? {});
    }
  }

  let guard = 0;
  while (guard < 10000) {
    guard += 1;
    const node = graph.nodes.get(currentId);
    if (!node) {
      throw new Error(`Current node not found: ${currentId}`);
    }
    context.set("current_node", node.id);

    if (isTerminal(node)) {
      const [gateOk, failedNode] = goalGateSatisfied(graph, nodeOutcomes);
      if (!gateOk && failedNode) {
        const retryTarget = getRetryTargetForNode(failedNode, graph);
        if (retryTarget) {
          currentId = retryTarget;
          continue;
        }
        return {
          status: "fail",
          completedNodes,
          nodeOutcomes,
          context: context.snapshot(),
          logsRoot,
        };
      }
      break;
    }

    const outcome = await executeWithRetry(node, graph, runtime, context, logsRoot, retryCounter);
    nodeOutcomes[node.id] = outcome;
    completedNodes.push(node.id);

    context.applyUpdates(outcome.context_updates);
    context.set("outcome", outcome.status);
    if (outcome.preferred_label) {
      context.set("preferred_label", outcome.preferred_label);
    }

    await writeNodeStatus(logsRoot, node.id, outcome);
    await saveCheckpoint(logsRoot, node.id, completedNodes, retryCounter, context);

    const nextEdge = selectEdge(node, outcome, context, graph);
    if (!nextEdge) {
      if (outcome.status === "fail") {
        const retryTarget = getRetryTargetForNode(node, graph);
        if (retryTarget) {
          currentId = retryTarget;
          continue;
        }
        return {
          status: "fail",
          completedNodes,
          nodeOutcomes,
          context: context.snapshot(),
          logsRoot,
        };
      }
      break;
    }
    currentId = nextEdge.to;
  }

  const [gateOk] = goalGateSatisfied(graph, nodeOutcomes);
  return {
    status: gateOk ? "success" : "fail",
    completedNodes,
    nodeOutcomes,
    context: context.snapshot(),
    logsRoot,
  };
}
