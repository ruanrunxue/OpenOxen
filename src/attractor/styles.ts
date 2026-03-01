import type { GraphSpec, NodeSpec } from "./model.ts";

type SelectorType = "universal" | "shape" | "class" | "id";

export interface StylesheetRule {
  selectorType: SelectorType;
  selectorValue: string;
  declarations: Record<string, string>;
  order: number;
}

function specificity(rule: StylesheetRule): number {
  if (rule.selectorType === "id") {
    return 3;
  }
  if (rule.selectorType === "class") {
    return 2;
  }
  if (rule.selectorType === "shape") {
    return 1;
  }
  return 0;
}

export function parseStylesheet(stylesheet: string): StylesheetRule[] {
  const input = stylesheet.trim();
  if (!input) {
    return [];
  }
  const rules: StylesheetRule[] = [];
  const ruleRe = /([*]|#[A-Za-z_][A-Za-z0-9_]*|\.[a-z0-9-]+|[A-Za-z_][A-Za-z0-9_]*)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  let order = 0;
  while ((match = ruleRe.exec(input)) !== null) {
    const rawSelector = match[1]!.trim();
    const body = match[2]!.trim();
    const declarations: Record<string, string> = {};
    for (const chunk of body.split(";")) {
      const line = chunk.trim();
      if (!line) {
        continue;
      }
      const idx = line.indexOf(":");
      if (idx <= 0) {
        throw new Error(`Invalid stylesheet declaration: ${line}`);
      }
      const prop = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
      declarations[prop] = value;
    }
    let selectorType: SelectorType = "shape";
    let selectorValue = rawSelector;
    if (rawSelector === "*") {
      selectorType = "universal";
      selectorValue = "*";
    } else if (rawSelector.startsWith("#")) {
      selectorType = "id";
      selectorValue = rawSelector.slice(1);
    } else if (rawSelector.startsWith(".")) {
      selectorType = "class";
      selectorValue = rawSelector.slice(1);
    }
    rules.push({ selectorType, selectorValue, declarations, order });
    order += 1;
  }
  if (!rules.length && input) {
    throw new Error("Invalid model_stylesheet syntax");
  }
  return rules;
}

function nodeHasClass(node: NodeSpec, className: string): boolean {
  const classAttr = String(node.attrs.class ?? "");
  if (!classAttr) {
    return false;
  }
  return classAttr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(className);
}

function matches(rule: StylesheetRule, node: NodeSpec): boolean {
  if (rule.selectorType === "universal") {
    return true;
  }
  if (rule.selectorType === "id") {
    return node.id === rule.selectorValue;
  }
  if (rule.selectorType === "class") {
    return nodeHasClass(node, rule.selectorValue);
  }
  return String(node.attrs.shape ?? "box") === rule.selectorValue;
}

export function applyStylesheet(graph: GraphSpec): void {
  const source = String(graph.attrs.model_stylesheet ?? "");
  if (!source.trim()) {
    return;
  }
  const rules = parseStylesheet(source).sort((a, b) => {
    const diff = specificity(a) - specificity(b);
    if (diff !== 0) {
      return diff;
    }
    return a.order - b.order;
  });

  for (const node of graph.nodes.values()) {
    for (const rule of rules) {
      if (!matches(rule, node)) {
        continue;
      }
      for (const [key, value] of Object.entries(rule.declarations)) {
        if (!(key in node.attrs)) {
          node.attrs[key] = value;
        }
      }
    }
  }
}

