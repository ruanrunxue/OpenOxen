import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";

import { asBoolean, asNumber, asString, SHAPE_TO_HANDLER, type GraphSpec, type NodeSpec, type Outcome } from "./model.ts";
import type { PipelineContext } from "./context.ts";
import type { Interviewer } from "./interviewer.ts";

const exec = promisify(execCb);

function ensureOutcome(value: unknown): Outcome {
  if (typeof value === "object" && value !== null && "status" in value) {
    const outcome = value as Outcome;
    return {
      status: outcome.status ?? "success",
      preferred_label: outcome.preferred_label,
      suggested_next_ids: outcome.suggested_next_ids,
      context_updates: outcome.context_updates ?? {},
      notes: outcome.notes,
      failure_reason: outcome.failure_reason,
    };
  }
  return {
    status: "success",
    context_updates: {},
    notes: typeof value === "string" ? value : undefined,
  };
}

export interface HandlerInput {
  node: NodeSpec;
  context: PipelineContext;
  graph: GraphSpec;
  logsRoot: string;
}

export interface Handler {
  execute(input: HandlerInput): Promise<Outcome> | Outcome;
}

export interface CodergenBackend {
  run(node: NodeSpec, prompt: string, context: PipelineContext): Promise<string | Outcome> | string | Outcome;
}

export class StartHandler implements Handler {
  execute(): Outcome {
    return { status: "success" };
  }
}

export class ExitHandler implements Handler {
  execute(): Outcome {
    return { status: "success" };
  }
}

function expandVariables(prompt: string, graph: GraphSpec, context: PipelineContext): string {
  const goal = asString(graph.attrs.goal, "");
  const resolve = (name: string): string => {
    const key = name.trim();
    if (!key) {
      return "";
    }
    if (key === "goal") {
      return goal;
    }
    if (key === "current_node") {
      return context.getString("current_node", "");
    }
    return context.getString(key, "");
  };

  let out = prompt;
  const variable = "([A-Za-z_][A-Za-z0-9_-]*(?:\\.[A-Za-z_][A-Za-z0-9_-]*)*)";
  out = out.replace(new RegExp(`\\$\\{${variable}\\}`, "g"), (_m, key: string) => resolve(key));
  out = out.replace(new RegExp(`\\$${variable}`, "g"), (_m, key: string) => resolve(key));
  return out;
}

function normalizeInlineCommand(value: string): string {
  let out = value.trim();
  if ((out.startsWith("`") && out.endsWith("`")) || (out.startsWith('"') && out.endsWith('"'))) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

function extractTestCommand(text: string): string | undefined {
  const marker = /(?:^|\n)\s*TEST_COMMAND\s*[:=]\s*(.+?)\s*(?:\n|$)/i.exec(text);
  if (marker?.[1]) {
    const candidate = normalizeInlineCommand(marker[1]);
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function resolveToolCommand(input: HandlerInput): { command?: string; error?: string } {
  const raw = asString(input.node.attrs.tool_command, "").trim();
  if (!raw) {
    return { error: "No tool_command specified" };
  }
  const defaultTestCommand = asString(input.graph.attrs.default_test_command, "").trim();
  const selectedTestCommand = input.context.getString("test.command", defaultTestCommand).trim();
  let command = raw;

  const hasPlaceholder = command.includes("$test_command") || command.includes("${test_command}");
  if (hasPlaceholder) {
    if (!selectedTestCommand) {
      return {
        error:
          "Unresolved $test_command placeholder. Provide TEST_COMMAND in write_tests output or set graph.default_test_command.",
      };
    }
    command = command.replaceAll("${test_command}", selectedTestCommand).replaceAll("$test_command", selectedTestCommand);
  }

  command = command.trim();
  if (!command) {
    return { error: "Resolved tool command is empty" };
  }
  return { command };
}

async function writeStageFile(logsRoot: string, nodeId: string, filename: string, content: string): Promise<void> {
  const file = join(logsRoot, nodeId, filename);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number;
  signal?: string;
  message?: string;
}

type TestIssueKind =
  | "missing_module"
  | "missing_playwright_browser"
  | "port_in_use"
  | "tests_failed"
  | "generic_error";

interface TestIssue {
  kind: TestIssueKind;
  reason: string;
}

async function executeCommand(command: string, timeoutMs: number): Promise<CommandResult> {
  try {
    const result = await exec(command, { timeout: timeoutMs });
    return {
      ok: true,
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    };
  } catch (error) {
    const execErr = error as {
      message?: string;
      stdout?: string;
      stderr?: string;
      code?: number;
      signal?: string;
    };
    return {
      ok: false,
      stdout: String(execErr.stdout ?? "").trim(),
      stderr: String(execErr.stderr ?? "").trim(),
      code: execErr.code,
      signal: execErr.signal,
      message: execErr.message,
    };
  }
}

function firstLineMatching(text: string, pattern: RegExp): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  return lines.find((line) => pattern.test(line));
}

function detectTestIssue(stdout: string, stderr: string): TestIssue | undefined {
  const combined = `${stderr}\n${stdout}`;
  const missingModule = firstLineMatching(combined, /cannot find module|module_not_found/i);
  if (missingModule) {
    return { kind: "missing_module", reason: missingModule };
  }
  const missingBrowser = firstLineMatching(
    combined,
    /browsertype\.launch:\s*executable doesn't exist|please run the following command to download new browsers|playwright install/i,
  );
  if (missingBrowser) {
    return { kind: "missing_playwright_browser", reason: missingBrowser };
  }
  const portInUse = firstLineMatching(combined, /eaddrinuse|address already in use/i);
  if (portInUse) {
    return { kind: "port_in_use", reason: portInUse };
  }
  const failedSummary = firstLineMatching(combined, /\b\d+\s+failed\b/i);
  if (failedSummary) {
    return { kind: "tests_failed", reason: failedSummary };
  }
  const genericError = firstLineMatching(combined, /error:/i);
  if (genericError) {
    return { kind: "generic_error", reason: genericError };
  }
  return undefined;
}

function remediationCommandsForIssue(issue: TestIssue, input: HandlerInput): string[] {
  const attrKeyByKind: Record<TestIssueKind, string> = {
    missing_module: "repair_missing_module_command",
    missing_playwright_browser: "repair_missing_browser_command",
    port_in_use: "repair_port_in_use_command",
    tests_failed: "repair_tests_failed_command",
    generic_error: "repair_generic_error_command",
  };
  const override = asString(input.graph.attrs[attrKeyByKind[issue.kind]], "").trim();
  if (override) {
    return [override];
  }

  if (issue.kind === "missing_module") {
    return ["npm install -D @playwright/test"];
  }
  if (issue.kind === "missing_playwright_browser") {
    return ["npx playwright install"];
  }
  if (issue.kind === "port_in_use") {
    const portMatch = /(port|:)\s*(\d{2,5})/i.exec(issue.reason);
    const port = portMatch?.[2] ?? "3000";
    return [`if lsof -ti tcp:${port} >/dev/null 2>&1; then kill -9 $(lsof -ti tcp:${port}); fi`];
  }
  return [];
}

function failureReasonFromResult(command: string, result: CommandResult, issue?: TestIssue): string {
  if (issue) {
    return `Test output indicates failure${result.ok ? " despite zero exit code" : ""}: ${issue.reason}`;
  }
  const reasonParts = [`Tool command failed: ${command}`];
  if (typeof result.code !== "undefined") {
    reasonParts.push(`exit_code=${String(result.code)}`);
  }
  if (result.signal) {
    reasonParts.push(`signal=${result.signal}`);
  }
  if (result.stderr) {
    reasonParts.push(`stderr=${result.stderr}`);
  } else if (result.stdout) {
    reasonParts.push(`stdout=${result.stdout}`);
  } else if (result.message) {
    reasonParts.push(result.message);
  }
  return reasonParts.join(" | ");
}

export class CodergenHandler implements Handler {
  #backend?: CodergenBackend;

  constructor(backend?: CodergenBackend) {
    this.#backend = backend;
  }

  async execute(input: HandlerInput): Promise<Outcome> {
    const prompt = expandVariables(
      asString(input.node.attrs.prompt, asString(input.node.attrs.label, input.node.id)),
      input.graph,
      input.context,
    );
    await writeStageFile(input.logsRoot, input.node.id, "prompt.md", prompt);

    let rawResult: string | Outcome = `[Simulated] Response for stage: ${input.node.id}`;
    if (this.#backend) {
      rawResult = await this.#backend.run(input.node, prompt, input.context);
    }
    const outcome = ensureOutcome(rawResult);
    const responseText =
      typeof rawResult === "string" ? rawResult : outcome.notes ?? JSON.stringify(rawResult, null, 2);
    const extractedTestCommand = extractTestCommand(responseText);

    await writeStageFile(input.logsRoot, input.node.id, "response.md", responseText);
    return {
      ...outcome,
      context_updates: {
        last_stage: input.node.id,
        last_response: responseText.slice(0, 200),
        ...(extractedTestCommand ? { "test.command": extractedTestCommand } : {}),
        ...(outcome.context_updates ?? {}),
      },
    };
  }
}

function parseAcceleratorKey(label: string): string {
  const trimmed = label.trim();
  const bracket = /^\[([A-Za-z0-9])\]/.exec(trimmed);
  if (bracket) {
    return bracket[1]!.toUpperCase();
  }
  const paren = /^([A-Za-z0-9])\)/.exec(trimmed);
  if (paren) {
    return paren[1]!.toUpperCase();
  }
  const dash = /^([A-Za-z0-9])\s*-/.exec(trimmed);
  if (dash) {
    return dash[1]!.toUpperCase();
  }
  return trimmed.charAt(0).toUpperCase();
}

export function normalizeLabel(label: string): string {
  return label
    .trim()
    .replace(/^\[[A-Za-z0-9]\]\s*/, "")
    .replace(/^[A-Za-z0-9]\)\s*/, "")
    .replace(/^[A-Za-z0-9]\s*-\s*/, "")
    .trim()
    .toLowerCase();
}

export class WaitForHumanHandler implements Handler {
  #interviewer: Interviewer;

  constructor(interviewer: Interviewer) {
    this.#interviewer = interviewer;
  }

  async execute(input: HandlerInput): Promise<Outcome> {
    const edges = input.graph.edges.filter((e) => e.from === input.node.id);
    if (!edges.length) {
      return { status: "fail", failure_reason: "No outgoing edges for human gate" };
    }
    const options = edges.map((edge) => {
      const label = asString(edge.attrs.label, edge.to);
      return { key: parseAcceleratorKey(label), label, to: edge.to };
    });
    const answer = await this.#interviewer.ask({
      text: asString(input.node.attrs.label, "Select an option:"),
      type: "MULTI_SELECT",
      options: options.map((o) => ({ key: o.key, label: o.label })),
      stage: input.node.id,
    });

    let selected = options.find((o) => o.key.toLowerCase() === String(answer.value).toLowerCase());
    if (!selected && answer.selected_option) {
      selected = options.find((o) => normalizeLabel(o.label) === normalizeLabel(answer.selected_option!.label));
    }
    selected ??= options[0]!;

    return {
      status: "success",
      preferred_label: selected.label,
      suggested_next_ids: [selected.to],
      context_updates: {
        "human.gate.selected": selected.key,
        "human.gate.label": selected.label,
      },
    };
  }
}

export class ConditionalHandler implements Handler {
  execute(input: HandlerInput): Outcome {
    return { status: "success", notes: `Conditional node evaluated: ${input.node.id}` };
  }
}

export class ParallelHandler implements Handler {
  execute(_input: HandlerInput): Outcome {
    return { status: "success", notes: "Parallel fan-out delegated to engine traversal" };
  }
}

export class FanInHandler implements Handler {
  execute(input: HandlerInput): Outcome {
    const results = input.context.get<unknown[]>("parallel.results", []);
    if (!results || !results.length) {
      return { status: "fail", failure_reason: "No parallel results to evaluate" };
    }
    return {
      status: "success",
      context_updates: {
        "parallel.fan_in.best_id": 0,
        "parallel.fan_in.best_outcome": "success",
      },
    };
  }
}

export class ToolHandler implements Handler {
  async execute(input: HandlerInput): Promise<Outcome> {
    const isTestNode = /^test(?:_|$)/i.test(input.node.id);
    const resolved = resolveToolCommand(input);
    if (resolved.error) {
      return {
        status: "fail",
        failure_reason: resolved.error,
        context_updates: isTestNode
          ? {
              "test.last_status": "fail",
              "test.last_failure": resolved.error,
            }
          : {},
      };
    }
    const command = resolved.command!;
    const timeoutMs = Number(input.node.attrs.timeout_ms ?? input.graph.attrs.default_timeout_ms ?? 120000);
    const autoRepairEnabled = isTestNode && asBoolean(input.graph.attrs.auto_test_repair, true);
    const maxRepairAttempts = Math.max(0, asNumber(input.graph.attrs.auto_test_repair_max_attempts, 1));
    const autoRepairLog: string[] = [];
    const attemptedRepairs = new Set<string>();

    let result = await executeCommand(command, timeoutMs);
    let testIssue = isTestNode ? detectTestIssue(result.stdout, result.stderr) : undefined;

    for (let i = 0; autoRepairEnabled && testIssue && i < maxRepairAttempts; i += 1) {
      const repairs = remediationCommandsForIssue(testIssue, input).filter((cmd) => cmd && !attemptedRepairs.has(cmd));
      if (repairs.length === 0) {
        break;
      }
      for (const repairCommand of repairs) {
        attemptedRepairs.add(repairCommand);
        autoRepairLog.push(`repair:start ${repairCommand}`);
        const repairResult = await executeCommand(repairCommand, timeoutMs);
        autoRepairLog.push(
          `repair:end ok=${String(repairResult.ok)} code=${String(repairResult.code ?? "")} stderr=${repairResult.stderr.slice(0, 300)}`,
        );
      }
      result = await executeCommand(command, timeoutMs);
      testIssue = detectTestIssue(result.stdout, result.stderr);
      if (result.ok && !testIssue) {
        break;
      }
    }

    const success = result.ok && (!isTestNode || !testIssue);
    const failureReason = success ? "" : failureReasonFromResult(command, result, testIssue);
    const updates: Record<string, unknown> = {
      "tool.last_command": command,
      "tool.last_stdout": result.stdout,
      "tool.last_stderr": result.stderr,
      "tool.last_status": success ? "success" : "fail",
      "tool.last_failure": success ? "" : failureReason,
    };
    if (isTestNode) {
      updates["test.last_command"] = command;
      updates["test.last_stdout"] = result.stdout;
      updates["test.last_stderr"] = result.stderr;
      updates["test.last_status"] = success ? "success" : "fail";
      updates["test.last_failure"] = success ? "" : failureReason;
      if (autoRepairLog.length > 0) {
        updates["test.auto_repair_log"] = autoRepairLog;
      }
    }
    if (success) {
      const noteSuffix = autoRepairLog.length > 0 ? ` after auto-repair (${autoRepairLog.length} steps)` : "";
      return {
        status: "success",
        context_updates: updates,
        notes: `Tool completed${noteSuffix}: ${command}`,
      };
    }
    return { status: "fail", failure_reason: failureReason, context_updates: updates };
  }
}

export class ManagerLoopHandler implements Handler {
  execute(): Outcome {
    return { status: "success", notes: "Manager loop no-op in local runtime" };
  }
}

export class HandlerRegistry {
  #handlers = new Map<string, Handler>();
  #defaultHandler: Handler;

  constructor(defaultHandler: Handler) {
    this.#defaultHandler = defaultHandler;
  }

  register(type: string, handler: Handler): void {
    this.#handlers.set(type, handler);
  }

  resolve(node: NodeSpec): Handler {
    const explicit = asString(node.attrs.type, "");
    if (explicit && this.#handlers.has(explicit)) {
      return this.#handlers.get(explicit)!;
    }
    const shape = asString(node.attrs.shape, "box");
    const mapped = SHAPE_TO_HANDLER[shape];
    if (mapped && this.#handlers.has(mapped)) {
      return this.#handlers.get(mapped)!;
    }
    return this.#defaultHandler;
  }
}
