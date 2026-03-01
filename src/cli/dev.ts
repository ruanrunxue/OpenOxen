import fs from "node:fs/promises";
import path from "node:path";

import {
  parseDot,
  runPipeline,
  createDefaultRuntime,
  ConsoleInterviewer,
  type GraphSpec,
  type PipelineRunResult,
} from "../attractor/index.ts";
import { LocalExecutionEnvironment, Session, createOpenAIProfile, type LLMClient, type SessionEvent } from "../agent/index.ts";
import { createPiAiCodergenBackend } from "../llm-client/pi-ai.ts";
import { resolvePipelineLogsRoot } from "../openoxen/paths.ts";

export interface DevCommandContext {
  cwd: string;
  now: Date;
  log: (line: string) => void;
  verbose?: boolean;
}

export interface DotRunResult {
  status: "success" | "fail";
  logsRoot: string;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

function colorize(text: string, color: keyof typeof ANSI): string {
  if (process.env.NO_COLOR === "1" || process.env.TERM === "dumb") {
    return text;
  }
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function traceEnabled(ctx: DevCommandContext): boolean {
  if (typeof ctx.verbose === "boolean") {
    return ctx.verbose;
  }
  return process.env.OPENOXEN_VERBOSE !== "0";
}

function shorten(text: string, max = 600): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}\n...[truncated ${normalized.length - max} chars]`;
}

function trace(ctx: DevCommandContext, line: string): void {
  if (!traceEnabled(ctx)) {
    return;
  }
  ctx.log(line);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatRoundSummary(request: {
  provider: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string }>;
}): string {
  const nonSystem = request.messages.filter((msg) => msg.role !== "system");
  const lastMessage = nonSystem[nonSystem.length - 1];
  const lastUser = [...nonSystem].reverse().find((msg) => msg.role === "user");
  const lastTool = [...nonSystem].reverse().find((msg) => msg.role === "tool");
  const parts = [
    `provider=${request.provider}`,
    `model=${request.model}`,
    `messages=${nonSystem.length}`,
    `tools=${request.tools.length}`,
  ];
  if (lastMessage) {
    parts.push(`last_role=${lastMessage.role}`);
  }
  const lines = [parts.join(" ")];
  if (lastUser?.content?.trim()) {
    lines.push(`input: ${shorten(lastUser.content, 280)}`);
  } else if (lastTool?.content?.trim()) {
    lines.push(`tool_result: ${shorten(lastTool.content, 280)}`);
  }
  return lines.join("\n");
}

function createTracingLlmClient(base: LLMClient, ctx: DevCommandContext, channel: string): LLMClient {
  let round = 0;
  return {
    async complete(request) {
      round += 1;
      const requestSummary = formatRoundSummary(request);
      const response = await base.complete(request);
      const responseSummary = [
        `output_text: ${shorten(response.text || "", 280)}`,
        `tool_calls=${response.tool_calls.length}${
          response.tool_calls.length ? ` (${response.tool_calls.map((c) => c.name).join(", ")})` : ""
        }`,
      ].join("\n");
      trace(
        ctx,
        [
          colorize(`[trace][${channel}][round ${round}]`, "cyan"),
          requestSummary,
          responseSummary,
        ].join("\n"),
      );
      return response;
    },
  };
}

function logSessionEvent(ctx: DevCommandContext, channel: string, event: SessionEvent): void {
  if (!traceEnabled(ctx)) {
    return;
  }
  if (event.kind === "ERROR") {
    trace(ctx, colorize(`[trace][${channel}] session_error ${safeJson(event.data)}`, "red"));
  }
}

function pad2(v: number): string {
  return String(v).padStart(2, "0");
}

export function formatTimestamp(input: Date): string {
  return [
    input.getUTCFullYear(),
    pad2(input.getUTCMonth() + 1),
    pad2(input.getUTCDate()),
    "-",
    pad2(input.getUTCHours()),
    pad2(input.getUTCMinutes()),
    pad2(input.getUTCSeconds()),
  ].join("");
}

export function sanitizeTaskName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function dotEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function findMatchingBrace(input: string, openPos: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openPos; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === "\"" && input[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function extractDigraphBlock(text: string): string | undefined {
  const match = /(?:strict\s+)?digraph\b/i.exec(text);
  if (!match) {
    return undefined;
  }
  const bodyStart = text.indexOf("{", match.index);
  if (bodyStart < 0) {
    return undefined;
  }
  const bodyEnd = findMatchingBrace(text, bodyStart);
  if (bodyEnd < 0) {
    return undefined;
  }
  return text.slice(match.index, bodyEnd + 1).trim();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function guessTestCommand(cwd: string, requirement: string): Promise<string> {
  const lowerReq = requirement.toLowerCase();
  if (lowerReq.includes("python")) {
    return "pytest";
  }
  if (lowerReq.includes("go")) {
    return "go test ./...";
  }
  if (lowerReq.includes("rust")) {
    return "cargo test";
  }

  if (await fileExists(path.join(cwd, "package.json"))) {
    return "npm test";
  }
  if (await fileExists(path.join(cwd, "pyproject.toml")) || (await fileExists(path.join(cwd, "pytest.ini")))) {
    return "pytest";
  }
  if (await fileExists(path.join(cwd, "go.mod"))) {
    return "go test ./...";
  }
  if (await fileExists(path.join(cwd, "Cargo.toml"))) {
    return "cargo test";
  }
  return "npm test";
}

export function buildFallbackDot(requirement: string, testCommand: string): string {
  const escapedGoal = dotEscape(requirement);
  const escapedCmd = dotEscape(testCommand);
  const lines: string[] = [];
  lines.push("digraph openoxen_dev {");
  lines.push(`  graph [goal="${escapedGoal}", default_test_command="${escapedCmd}", default_timeout_ms=120000]`);
  lines.push("");
  lines.push("  start [shape=Mdiamond]");
  lines.push(
    '  write_tests [shape=box, prompt="Create executable tests for: $goal in the current workspace. Use tools to create or update test files, then output exactly one line: TEST_COMMAND: <command>."]',
  );
  lines.push("  human_intervention [shape=hexagon, label=\"Manual intervention required\"]");
  lines.push(`  abort [shape=parallelogram, tool_command="exit 1"]`);
  lines.push("  done [shape=Msquare]");
  lines.push("");
  for (let i = 1; i <= 5; i += 1) {
    lines.push(
      `  develop_${i} [shape=box, prompt="Implement requirement: $goal based on tests. Iteration ${i}. Test command: $test.command. Last test failure: $test.last_failure"]`,
    );
    lines.push(
      `  review_${i} [shape=box, prompt="Review current implementation for correctness and risks. Iteration ${i}."]`,
    );
    lines.push(`  test_${i} [shape=parallelogram, tool_command="$test_command"]`);
  }
  lines.push("");
  lines.push("  start -> write_tests");
  lines.push("  write_tests -> develop_1");
  for (let i = 1; i <= 5; i += 1) {
    lines.push(`  develop_${i} -> review_${i}`);
    lines.push(`  review_${i} -> test_${i}`);
    lines.push(`  test_${i} -> done [condition="outcome=success"]`);
    if (i < 5) {
      lines.push(`  test_${i} -> develop_${i + 1} [condition="outcome=fail"]`);
    } else {
      lines.push(`  test_${i} -> human_intervention [condition="outcome=fail", label="Need human"]`);
    }
  }
  lines.push('  human_intervention -> develop_1 [label="[C] Continue"]');
  lines.push('  human_intervention -> abort [label="[S] Stop"]');
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function extractDot(text: string): string | undefined {
  const fenced = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null = null;
  while (true) {
    match = fenced.exec(text);
    if (!match) {
      break;
    }
    const block = match[1] ?? "";
    const dot = extractDigraphBlock(block);
    if (dot) {
      return dot;
    }
  }
  return extractDigraphBlock(text);
}

function conditionIncludesOutcome(condition: string, outcome: "success" | "fail"): boolean {
  return condition
    .toLowerCase()
    .split("&&")
    .map((x) => x.trim())
    .some((clause) => clause === `outcome=${outcome}`);
}

export function hasExpectedTestRouting(graph: GraphSpec): boolean {
  const testNodes = [...graph.nodes.values()].filter((node) => String(node.attrs.shape) === "parallelogram");
  if (testNodes.length === 0) {
    return false;
  }
  for (const testNode of testNodes) {
    const edges = graph.edges.filter((edge) => edge.from === testNode.id);
    const conditions = edges
      .map((edge) => String(edge.attrs.condition ?? ""))
      .map((x) => x.trim())
      .filter(Boolean);
    const hasSuccess = conditions.some((cond) => conditionIncludesOutcome(cond, "success"));
    const hasFail = conditions.some((cond) => conditionIncludesOutcome(cond, "fail"));
    if (!hasSuccess || !hasFail) {
      return false;
    }
  }
  return true;
}

function hasEdge(
  graph: GraphSpec,
  from: string,
  to: string,
  predicate?: (edge: GraphSpec["edges"][number]) => boolean,
): boolean {
  return graph.edges.some((edge) => edge.from === from && edge.to === to && (predicate ? predicate(edge) : true));
}

function outgoing(graph: GraphSpec, nodeId: string): GraphSpec["edges"] {
  return graph.edges.filter((edge) => edge.from === nodeId);
}

function isSuccessCondition(edge: GraphSpec["edges"][number]): boolean {
  return conditionIncludesOutcome(String(edge.attrs.condition ?? ""), "success");
}

function isFailCondition(edge: GraphSpec["edges"][number]): boolean {
  return conditionIncludesOutcome(String(edge.attrs.condition ?? ""), "fail");
}

export function hasExpectedDevPipelineContract(graph: GraphSpec): boolean {
  const requiredNodes = ["start", "write_tests", "human_intervention", "abort", "done"];
  for (const id of requiredNodes) {
    if (!graph.nodes.has(id)) {
      return false;
    }
  }

  if (!hasEdge(graph, "start", "write_tests")) {
    return false;
  }
  if (!hasEdge(graph, "write_tests", "develop_1")) {
    return false;
  }
  if (!hasEdge(graph, "human_intervention", "develop_1")) {
    return false;
  }
  if (!hasEdge(graph, "human_intervention", "abort")) {
    return false;
  }

  for (let i = 1; i <= 5; i += 1) {
    const developId = `develop_${i}`;
    const reviewId = `review_${i}`;
    const testId = `test_${i}`;
    if (!graph.nodes.has(developId) || !graph.nodes.has(reviewId) || !graph.nodes.has(testId)) {
      return false;
    }

    if (!hasEdge(graph, developId, reviewId)) {
      return false;
    }

    const reviewOut = outgoing(graph, reviewId);
    if (reviewOut.length !== 1 || reviewOut[0]!.to !== testId) {
      return false;
    }

    if (!hasEdge(graph, testId, "done", isSuccessCondition)) {
      return false;
    }
    const failTarget = i < 5 ? `develop_${i + 1}` : "human_intervention";
    if (!hasEdge(graph, testId, failTarget, isFailCondition)) {
      return false;
    }
  }

  return true;
}

export function deriveCliRunStatus(result: PipelineRunResult): "success" | "fail" {
  if (result.status !== "success") {
    return "fail";
  }
  for (const [nodeId, outcome] of Object.entries(result.nodeOutcomes)) {
    if (/^test(?:_|$)/i.test(nodeId) && outcome.status === "fail") {
      return "fail";
    }
  }
  return "success";
}

function createDotGenerationPrompt(requirement: string, testCommand: string): string {
  return [
    "Generate a Graphviz DOT pipeline for an implementation task.",
    "Return DOT only (no prose).",
    "Must include this flow:",
    "write_tests -> develop -> review -> test",
    "test success => done",
    "test failure => continue development, and after 5 failed rounds route to human_intervention",
    "human_intervention has two choices: continue (back to develop_1), stop (to abort node).",
    "Constraints:",
    "- exactly one start node shape=Mdiamond",
    "- exactly one done node shape=Msquare",
    "- exactly five rounds: develop_1..5, review_1..5, test_1..5",
    "- each review_i must have exactly one outgoing edge to test_i",
    "- no review_i -> develop_j edges",
    "- test nodes must be shape=parallelogram with tool_command",
    '- use graph attr default_test_command="<command>" and set each test node to tool_command="$test_command"',
    `- use this default test command value: ${testCommand}`,
    "- use escaped quoted values and commas between attributes",
    "",
    `Requirement: ${requirement}`,
  ].join("\n");
}

export async function generateDotWithAgent(
  requirement: string,
  llmClient: LLMClient,
  ctx: DevCommandContext,
): Promise<string> {
  const testCommand = await guessTestCommand(ctx.cwd, requirement);
  const profile = createOpenAIProfile(process.env.OPENOXEN_MODEL ?? "gpt-5.2-codex");
  // DOT generation should be text-only; disable tools to prevent file mutations.
  for (const name of profile.toolRegistry.names()) {
    profile.toolRegistry.unregister(name);
  }
  const env = new LocalExecutionEnvironment({ workingDir: ctx.cwd });
  const tracedLlm = createTracingLlmClient(llmClient, ctx, "dot");
  const session = new Session({
    providerProfile: profile,
    executionEnv: env,
    llmClient: tracedLlm,
    config: { max_tool_rounds_per_input: 1, max_turns: 8 },
    onEvent: (event) => logSessionEvent(ctx, "dot", event),
  });

  const prompt = createDotGenerationPrompt(requirement, testCommand);
  trace(ctx, colorize(`[trace][dot] submit requirement (len=${prompt.length})`, "cyan"));
  const response = await session.submit(prompt);
  trace(ctx, colorize(`[trace][dot] model response received (len=${response.text.length})`, "cyan"));
  const dot = extractDot(response.text);
  if (dot) {
    try {
      const parsed = parseDot(dot);
      if (!hasExpectedTestRouting(parsed)) {
        throw new Error("DOT missing explicit outcome routing for test nodes");
      }
      if (!hasExpectedDevPipelineContract(parsed)) {
        throw new Error("DOT violates required dev/review/test contract");
      }
      return `${dot.trim()}\n`;
    } catch (error) {
      ctx.log(colorize(`Generated DOT invalid, using fallback template. Cause: ${String(error)}`, "yellow"));
    }
  } else {
    ctx.log(colorize("Model response did not include DOT, using fallback template.", "yellow"));
  }
  return buildFallbackDot(requirement, testCommand);
}

export async function runDotImmediately(dotSource: string, llmClient: LLMClient, ctx: DevCommandContext): Promise<DotRunResult> {
  const ts = formatTimestamp(ctx.now);
  const logsRoot = resolvePipelineLogsRoot(ctx.cwd, `pipeline.${ts}`);
  const graph = parseDot(dotSource);
  const tracedLlm = createTracingLlmClient(llmClient, ctx, "pipeline");

  const runtime = createDefaultRuntime({
    codergenBackend: createPiAiCodergenBackend(tracedLlm, {
      providerProfile: createOpenAIProfile(process.env.OPENOXEN_MODEL ?? "gpt-5.2-codex"),
      executionEnv: new LocalExecutionEnvironment({ workingDir: ctx.cwd }),
      reasoning_effort: process.env.OPENOXEN_REASONING_EFFORT ?? null,
      onSessionEvent: (event) => logSessionEvent(ctx, "pipeline", event),
      onAgentInput: ({ nodeId, prompt }) => {
        trace(ctx, colorize(`[trace][pipeline] stage=${nodeId} input_len=${prompt.length}`, "cyan"));
      },
      onAgentOutput: ({ nodeId, responseText }) => {
        trace(ctx, colorize(`[trace][pipeline] stage=${nodeId} output_len=${responseText.length}`, "cyan"));
      },
    }),
    interviewer: new ConsoleInterviewer(),
  });

  const result = await runPipeline(graph, { logsRoot, runtime });
  const testOutcomes = Object.entries(result.nodeOutcomes)
    .filter(([nodeId]) => /^test(?:_|$)/i.test(nodeId))
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [nodeId, outcome] of testOutcomes) {
    const label = `[${nodeId}] ${outcome.status.toUpperCase()}`;
    if (outcome.status === "success" || outcome.status === "partial_success") {
      ctx.log(colorize(label, "green"));
    } else if (outcome.status === "fail") {
      const reason = outcome.failure_reason ? ` - ${shorten(outcome.failure_reason, 240)}` : "";
      ctx.log(colorize(`${label}${reason}`, "red"));
    } else {
      ctx.log(colorize(label, "yellow"));
    }
  }
  return { status: deriveCliRunStatus(result), logsRoot };
}
