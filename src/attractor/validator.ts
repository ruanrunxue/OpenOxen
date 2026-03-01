import { validateConditionSyntax } from "./condition.ts";
import { parseStylesheet } from "./styles.ts";
import type { Diagnostic, GraphSpec } from "./model.ts";

function outgoing(graph: GraphSpec, nodeId: string) {
  return graph.edges.filter((e) => e.from === nodeId);
}

function incoming(graph: GraphSpec, nodeId: string) {
  return graph.edges.filter((e) => e.to === nodeId);
}

function findStartNodes(graph: GraphSpec): string[] {
  return [...graph.nodes.values()]
    .filter((n) => n.attrs.shape === "Mdiamond" || n.id === "start" || n.id === "Start")
    .map((n) => n.id);
}

function findExitNodes(graph: GraphSpec): string[] {
  return [...graph.nodes.values()]
    .filter((n) => n.attrs.shape === "Msquare" || n.id === "exit" || n.id === "end")
    .map((n) => n.id);
}

function reachability(graph: GraphSpec, start: string): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  const graphRetryTargets = [
    String(graph.attrs.retry_target ?? ""),
    String(graph.attrs.fallback_retry_target ?? ""),
  ].filter(Boolean);
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) {
      continue;
    }
    seen.add(cur);
    for (const edge of graph.edges) {
      if (edge.from === cur && !seen.has(edge.to)) {
        queue.push(edge.to);
      }
    }
    const node = graph.nodes.get(cur);
    const retryTargets = [
      String(node?.attrs.retry_target ?? ""),
      String(node?.attrs.fallback_retry_target ?? ""),
    ].filter(Boolean);
    for (const target of retryTargets) {
      if (graph.nodes.has(target) && !seen.has(target)) {
        queue.push(target);
      }
    }
    for (const target of graphRetryTargets) {
      if (graph.nodes.has(target) && !seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return seen;
}

export function validate(graph: GraphSpec): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const starts = findStartNodes(graph);
  const exits = findExitNodes(graph);

  if (starts.length !== 1) {
    diags.push({
      rule: "start_node",
      severity: "error",
      message: "Graph must define exactly one start node",
    });
  }

  if (exits.length !== 1) {
    diags.push({
      rule: "terminal_node",
      severity: "error",
      message: "Graph must define exactly one exit node",
    });
  }

  if (starts.length === 1) {
    if (incoming(graph, starts[0]!).length > 0) {
      diags.push({
        rule: "start_no_incoming",
        severity: "error",
        message: "Start node must not have incoming edges",
        node_id: starts[0],
      });
    }
    const reachable = reachability(graph, starts[0]!);
    for (const nodeId of graph.nodes.keys()) {
      if (!reachable.has(nodeId)) {
        diags.push({
          rule: "reachability",
          severity: "error",
          message: `Node ${nodeId} is not reachable from start`,
          node_id: nodeId,
        });
      }
    }
  }

  for (const exitId of exits) {
    if (outgoing(graph, exitId).length > 0) {
      diags.push({
        rule: "exit_no_outgoing",
        severity: "error",
        message: "Exit node must not have outgoing edges",
        node_id: exitId,
      });
    }
  }

  for (const edge of graph.edges) {
    if (!graph.nodes.has(edge.to)) {
      diags.push({
        rule: "edge_target_exists",
        severity: "error",
        message: `Edge references missing target node ${edge.to}`,
        edge: [edge.from, edge.to],
      });
    }
    const condition = String(edge.attrs.condition ?? "");
    const syntaxError = validateConditionSyntax(condition);
    if (syntaxError) {
      diags.push({
        rule: "condition_syntax",
        severity: "error",
        message: syntaxError,
        edge: [edge.from, edge.to],
      });
    }
  }

  const stylesheet = String(graph.attrs.model_stylesheet ?? "");
  if (stylesheet.trim()) {
    try {
      parseStylesheet(stylesheet);
    } catch (error) {
      diags.push({
        rule: "stylesheet_syntax",
        severity: "error",
        message: String(error),
      });
    }
  }

  for (const node of graph.nodes.values()) {
    const shape = String(node.attrs.shape ?? "box");
    if (shape === "box") {
      const prompt = String(node.attrs.prompt ?? "");
      const label = String(node.attrs.label ?? "");
      if (!prompt.trim() && !label.trim()) {
        diags.push({
          rule: "prompt_on_llm_nodes",
          severity: "warning",
          message: `Node ${node.id} has no prompt/label`,
          node_id: node.id,
        });
      }
    }
  }

  return diags;
}

export function validateOrRaise(graph: GraphSpec): Diagnostic[] {
  const diagnostics = validate(graph);
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length) {
    const message = errors.map((d) => `[${d.rule}] ${d.message}`).join("; ");
    throw new Error(`Graph validation failed: ${message}`);
  }
  return diagnostics;
}
