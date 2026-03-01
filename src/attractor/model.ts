export type AttrValue = string | number | boolean;

export type StageStatus = "success" | "fail" | "partial_success" | "retry" | "skipped";

export interface NodeSpec {
  id: string;
  attrs: Record<string, AttrValue>;
}

export interface EdgeSpec {
  from: string;
  to: string;
  attrs: Record<string, AttrValue>;
}

export interface GraphSpec {
  id: string;
  attrs: Record<string, AttrValue>;
  nodes: Map<string, NodeSpec>;
  edges: EdgeSpec[];
}

export interface Outcome {
  status: StageStatus;
  preferred_label?: string;
  suggested_next_ids?: string[];
  context_updates?: Record<string, unknown>;
  notes?: string;
  failure_reason?: string;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  rule: string;
  severity: DiagnosticSeverity;
  message: string;
  node_id?: string;
  edge?: [string, string];
}

export interface Checkpoint {
  timestamp: string;
  current_node: string;
  completed_nodes: string[];
  node_retries: Record<string, number>;
  context_values: Record<string, unknown>;
}

export const SHAPE_TO_HANDLER: Record<string, string> = {
  Mdiamond: "start",
  Msquare: "exit",
  box: "codergen",
  hexagon: "wait.human",
  diamond: "conditional",
  component: "parallel",
  tripleoctagon: "parallel.fan_in",
  parallelogram: "tool",
  house: "stack.manager_loop",
};

export function asString(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true;
    }
    if (value.toLowerCase() === "false") {
      return false;
    }
  }
  return fallback;
}

