import type { Outcome } from "./model.ts";

function normalizeLiteral(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"") && value.length >= 2) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, "\"");
  }
  return value;
}

export function validateConditionSyntax(condition: string): string | null {
  const trimmed = condition.trim();
  if (!trimmed) {
    return null;
  }
  const clauses = trimmed.split("&&");
  for (const clause of clauses) {
    const part = clause.trim();
    if (!part) {
      return "empty clause in condition expression";
    }
    if (!part.includes("=")) {
      return `invalid clause "${part}"`;
    }
    const hasNotEq = part.includes("!=");
    const op = hasNotEq ? "!=" : "=";
    const pieces = part.split(op);
    if (pieces.length !== 2 || !pieces[0]?.trim() || !pieces[1]?.trim()) {
      return `invalid clause "${part}"`;
    }
  }
  return null;
}

function readContextValue(context: Map<string, unknown> | Record<string, unknown>, key: string): unknown {
  if (context instanceof Map) {
    if (context.has(key)) {
      return context.get(key);
    }
    if (key.startsWith("context.") && context.has(key.slice("context.".length))) {
      return context.get(key.slice("context.".length));
    }
    return undefined;
  }
  if (key in context) {
    return context[key];
  }
  if (key.startsWith("context.")) {
    const stripped = key.slice("context.".length);
    return context[stripped];
  }
  return undefined;
}

function resolveKey(
  key: string,
  outcome: Pick<Outcome, "status" | "preferred_label">,
  context: Map<string, unknown> | Record<string, unknown>,
): string {
  const trimmed = key.trim();
  if (trimmed === "outcome") {
    return String(outcome.status ?? "");
  }
  if (trimmed === "preferred_label") {
    return String(outcome.preferred_label ?? "");
  }
  const value = readContextValue(context, trimmed);
  return value === undefined || value === null ? "" : String(value);
}

export function evaluateCondition(
  condition: string,
  outcome: Pick<Outcome, "status" | "preferred_label">,
  context: Map<string, unknown> | Record<string, unknown>,
): boolean {
  const trimmed = condition.trim();
  if (!trimmed) {
    return true;
  }
  const syntaxError = validateConditionSyntax(trimmed);
  if (syntaxError) {
    return false;
  }
  const clauses = trimmed.split("&&");
  for (const clause of clauses) {
    const part = clause.trim();
    if (!part) {
      continue;
    }
    const op = part.includes("!=") ? "!=" : "=";
    const [left, right] = part.split(op);
    const lhs = resolveKey(left!.trim(), outcome, context);
    const rhs = normalizeLiteral(right!.trim());
    if (op === "!=") {
      if (lhs === rhs) {
        return false;
      }
    } else if (lhs !== rhs) {
      return false;
    }
  }
  return true;
}

