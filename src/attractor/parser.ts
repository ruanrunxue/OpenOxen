import { applyStylesheet } from "./styles.ts";
import type { AttrValue, EdgeSpec, GraphSpec, NodeSpec } from "./model.ts";

interface ParseState {
  graph: GraphSpec;
  nodeDefaults: Record<string, AttrValue>;
  edgeDefaults: Record<string, AttrValue>;
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_.]/.test(ch);
}

function stripComments(input: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < input.length) {
    const ch = input[i]!;
    const next = input[i + 1] ?? "";
    if (ch === "\"" && input[i - 1] !== "\\") {
      inString = !inString;
      out += ch;
      i += 1;
      continue;
    }
    if (!inString && ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }
    if (!inString && ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function readIdentifier(input: string, start: number): { value: string; next: number } {
  let i = start;
  while (i < input.length && /\s/.test(input[i]!)) {
    i += 1;
  }
  const begin = i;
  while (i < input.length && isIdentChar(input[i]!)) {
    i += 1;
  }
  return { value: input.slice(begin, i).trim(), next: i };
}

function findMatching(input: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === "\"" && input[i - 1] !== "\\") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function decodeString(value: string): string {
  const inner = value.slice(1, -1);
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

function parseValue(raw: string): AttrValue {
  const value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return decodeString(value);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (/^-?\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number.parseFloat(value);
  }
  return value;
}

function splitByComma(input: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === "\"" && input[i - 1] !== "\\") {
      inString = !inString;
      current += ch;
      continue;
    }
    if (!inString && ch === ",") {
      if (current.trim()) {
        chunks.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

function parseAttrBlock(block: string): Record<string, AttrValue> {
  const trimmed = block.trim();
  if (!trimmed) {
    return {};
  }
  const attrs: Record<string, AttrValue> = {};
  for (const part of splitByComma(trimmed)) {
    const idx = part.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    attrs[key] = parseValue(value);
  }
  return attrs;
}

function findAttrBlock(statement: string): { head: string; attrs: Record<string, AttrValue> } {
  const open = statement.indexOf("[");
  if (open < 0) {
    return { head: statement.trim(), attrs: {} };
  }
  const close = findMatching(statement, open, "[", "]");
  if (close < 0) {
    return { head: statement.trim(), attrs: {} };
  }
  return {
    head: statement.slice(0, open).trim(),
    attrs: parseAttrBlock(statement.slice(open + 1, close)),
  };
}

function splitTopLevelStatements(block: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let bracketDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < block.length; i += 1) {
    const ch = block[i]!;
    if (ch === "\"" && block[i - 1] !== "\\") {
      inString = !inString;
      current += ch;
      continue;
    }
    if (!inString) {
      if (ch === "[") {
        bracketDepth += 1;
      } else if (ch === "]") {
        bracketDepth -= 1;
      } else if (ch === "{") {
        braceDepth += 1;
      } else if (ch === "}") {
        braceDepth -= 1;
      }
      if ((ch === ";" || ch === "\n") && bracketDepth === 0 && braceDepth === 0) {
        if (current.trim()) {
          statements.push(current.trim());
        }
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) {
    statements.push(current.trim());
  }
  return statements.filter(Boolean);
}

function mergeAttrs(
  base: Record<string, AttrValue>,
  next: Record<string, AttrValue>,
): Record<string, AttrValue> {
  return { ...base, ...next };
}

function ensureNode(state: ParseState, id: string, attrs: Record<string, AttrValue>): NodeSpec {
  if (!state.graph.nodes.has(id)) {
    state.graph.nodes.set(id, { id, attrs: { ...attrs } });
  } else {
    const current = state.graph.nodes.get(id)!;
    current.attrs = { ...current.attrs, ...attrs };
  }
  return state.graph.nodes.get(id)!;
}

function parseEdgeChain(head: string): string[] {
  const ids: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < head.length; i += 1) {
    const ch = head[i]!;
    if (ch === "\"" && head[i - 1] !== "\\") {
      inString = !inString;
      current += ch;
      continue;
    }
    if (!inString && ch === "-" && head[i + 1] === ">") {
      if (current.trim()) {
        ids.push(current.trim());
      }
      current = "";
      i += 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    ids.push(current.trim());
  }
  return ids;
}

function parseStatement(statement: string, state: ParseState): void {
  const trimmed = statement.trim();
  if (!trimmed) {
    return;
  }
  if (trimmed.startsWith("subgraph")) {
    const braceStart = trimmed.indexOf("{");
    if (braceStart < 0) {
      return;
    }
    const braceEnd = findMatching(trimmed, braceStart, "{", "}");
    if (braceEnd < 0) {
      return;
    }
    const body = trimmed.slice(braceStart + 1, braceEnd);
    const child: ParseState = {
      graph: state.graph,
      nodeDefaults: { ...state.nodeDefaults },
      edgeDefaults: { ...state.edgeDefaults },
    };
    parseBlock(body, child);
    return;
  }

  if (trimmed.startsWith("graph")) {
    const { attrs } = findAttrBlock(trimmed);
    state.graph.attrs = mergeAttrs(state.graph.attrs, attrs);
    return;
  }
  if (trimmed.startsWith("node")) {
    const { attrs } = findAttrBlock(trimmed);
    state.nodeDefaults = mergeAttrs(state.nodeDefaults, attrs);
    return;
  }
  if (trimmed.startsWith("edge")) {
    const { attrs } = findAttrBlock(trimmed);
    state.edgeDefaults = mergeAttrs(state.edgeDefaults, attrs);
    return;
  }

  const { head, attrs } = findAttrBlock(trimmed);

  if (head.includes("->")) {
    const chain = parseEdgeChain(head);
    if (chain.length < 2) {
      return;
    }
    const edgeAttrs = mergeAttrs(state.edgeDefaults, attrs);
    for (let i = 0; i < chain.length - 1; i += 1) {
      const from = chain[i]!;
      const to = chain[i + 1]!;
      ensureNode(state, from, { ...state.nodeDefaults, id: from });
      ensureNode(state, to, { ...state.nodeDefaults, id: to });
      const edge: EdgeSpec = { from, to, attrs: { ...edgeAttrs } };
      state.graph.edges.push(edge);
    }
    return;
  }

  if (head.includes("=") && !head.includes(" ")) {
    const idx = head.indexOf("=");
    const key = head.slice(0, idx).trim();
    const value = head.slice(idx + 1).trim();
    if (key) {
      state.graph.attrs[key] = parseValue(value);
    }
    return;
  }

  const nodeId = head.trim();
  if (!nodeId) {
    return;
  }
  ensureNode(state, nodeId, mergeAttrs(state.nodeDefaults, attrs));
}

function parseBlock(block: string, state: ParseState): void {
  for (const statement of splitTopLevelStatements(block)) {
    parseStatement(statement, state);
  }
}

export function parseDot(source: string): GraphSpec {
  const cleaned = stripComments(source);
  const dg = /\bdigraph\b/im.exec(cleaned);
  if (!dg) {
    throw new Error("DOT source must define exactly one digraph");
  }
  const bodyStart = cleaned.indexOf("{", dg.index);
  if (bodyStart < 0) {
    throw new Error("Malformed digraph body");
  }
  const head = cleaned.slice(dg.index + dg[0].length, bodyStart).trim();
  let graphId = "graph";
  if (head) {
    if (head.startsWith("\"") && head.endsWith("\"")) {
      graphId = decodeString(head);
    } else {
      graphId = head.split(/\s+/)[0] ?? "graph";
    }
  }
  const bodyEnd = findMatching(cleaned, bodyStart, "{", "}");
  if (bodyEnd < 0) {
    throw new Error("Malformed digraph body");
  }
  const body = cleaned.slice(bodyStart + 1, bodyEnd);
  const graph: GraphSpec = {
    id: graphId,
    attrs: {},
    nodes: new Map(),
    edges: [],
  };
  const state: ParseState = {
    graph,
    nodeDefaults: {},
    edgeDefaults: {},
  };
  parseBlock(body, state);

  for (const [id, node] of graph.nodes) {
    if (!("shape" in node.attrs)) {
      node.attrs.shape = "box";
    }
    if (!("label" in node.attrs)) {
      node.attrs.label = id;
    }
  }

  applyStylesheet(graph);
  return graph;
}
