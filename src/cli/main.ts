import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createPiAiClientAdapterFromEnv, loginPiWithOauthFromEnv, type LLMClient } from "../llm-client/pi-ai.ts";
import { formatTimestamp, generateDotWithAgent, runDotImmediately, sanitizeTaskName, type DotRunResult } from "./dev.ts";

export interface CliDeps {
  cwd: () => string;
  now: () => Date;
  log: (line: string) => void;
  error: (line: string) => void;
  writeFile: (filePath: string, content: string) => Promise<void>;
  createLlmClient: () => Promise<LLMClient>;
  loginOauth: (provider: string) => Promise<{ provider: string; status: "ok"; raw?: unknown }>;
  generateDot: (
    requirement: string,
    params: { taskName?: string; cwd: string; now: Date; llmClient: LLMClient; verbose: boolean },
  ) => Promise<string>;
  runDot: (dotSource: string, params: { cwd: string; now: Date; llmClient: LLMClient; verbose: boolean }) => Promise<DotRunResult>;
}

const ANSI = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
} as const;

function colorize(text: string, color: keyof typeof ANSI): string {
  if (process.env.NO_COLOR === "1" || process.env.TERM === "dumb") {
    return text;
  }
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function usage(): string {
  return [
    "Usage:",
    "  openoxen dev \"<需求>\" [--task <name>] [--quiet|--verbose]",
    "  openoxen login [--provider <name>]",
    "",
    "Examples:",
    "  openoxen dev \"实现用户登录\"",
    "  openoxen dev \"实现支付接口\" --task payment-api --quiet",
    "  openoxen login",
  ].join("\n");
}

function parseDevArgs(args: string[]): { requirement: string; taskName?: string; verbose: boolean; error?: string } {
  const requirementParts: string[] = [];
  let taskName: string | undefined;
  let verbose = process.env.OPENOXEN_VERBOSE !== "0";

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--task") {
      const next = args[i + 1];
      if (!next) {
        return { requirement: "", verbose, error: "Missing value for --task" };
      }
      taskName = next;
      i += 1;
      continue;
    }
    if (token === "--quiet") {
      verbose = false;
      continue;
    }
    if (token === "--verbose") {
      verbose = true;
      continue;
    }
    requirementParts.push(token);
  }

  const requirement = requirementParts.join(" ").trim();
  if (!requirement) {
    return { requirement: "", taskName, verbose, error: "Missing requirement" };
  }
  return { requirement, taskName, verbose };
}

function resolveDotFilename(now: Date, taskName: string | undefined): string {
  if (taskName) {
    const clean = sanitizeTaskName(taskName);
    if (clean) {
      return `${clean}.dot`;
    }
  }
  return `openoxen.pipeline.${formatTimestamp(now)}.dot`;
}

function parseLoginArgs(args: string[]): { provider: string; error?: string } {
  let provider = "openai-codex";
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--provider") {
      const next = args[i + 1];
      if (!next) {
        return { provider, error: "Missing value for --provider" };
      }
      provider = next;
      i += 1;
      continue;
    }
    return { provider, error: `Unknown argument for login: ${token}` };
  }
  return { provider };
}

function defaultDeps(): CliDeps {
  return {
    cwd: () => process.cwd(),
    now: () => new Date(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    writeFile: async (filePath, content) => {
      await fs.writeFile(filePath, content, "utf8");
    },
    createLlmClient: () => createPiAiClientAdapterFromEnv(),
    loginOauth: (provider: string) => loginPiWithOauthFromEnv(provider),
    generateDot: async (requirement, params) => {
      return generateDotWithAgent(requirement, params.llmClient, {
        cwd: params.cwd,
        now: params.now,
        log: console.log,
        verbose: params.verbose,
      });
    },
    runDot: async (dotSource, params) => {
      return runDotImmediately(dotSource, params.llmClient, {
        cwd: params.cwd,
        now: params.now,
        log: console.log,
        verbose: params.verbose,
      });
    },
  };
}

export async function runCli(argv: string[], partialDeps: Partial<CliDeps> = {}): Promise<number> {
  const deps = { ...defaultDeps(), ...partialDeps } as CliDeps;
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    deps.log(usage());
    return 0;
  }
  if (command === "login") {
    const parsedLogin = parseLoginArgs(rest);
    if (parsedLogin.error) {
      deps.error(parsedLogin.error);
      deps.error(usage());
      return 1;
    }
    try {
      deps.log(`Starting OAuth login via pi module (provider=${parsedLogin.provider})...`);
      await deps.loginOauth(parsedLogin.provider);
      deps.log(`OAuth login successful for provider: ${parsedLogin.provider}`);
      return 0;
    } catch (error) {
      deps.error(String(error));
      return 1;
    }
  }

  if (command !== "dev") {
    deps.error(`Unknown command: ${command}`);
    deps.error(usage());
    return 1;
  }

  const parsed = parseDevArgs(rest);
  if (parsed.error) {
    deps.error(parsed.error);
    deps.error(usage());
    return 1;
  }

  const cwd = deps.cwd();
  const now = deps.now();
  const llmClient = await deps.createLlmClient();
  const dot = await deps.generateDot(parsed.requirement, {
    taskName: parsed.taskName,
    cwd,
    now,
    llmClient,
    verbose: parsed.verbose,
  });

  const filename = resolveDotFilename(now, parsed.taskName);
  const dotPath = path.join(cwd, filename);
  await deps.writeFile(dotPath, dot);
  deps.log(`DOT saved: ${dotPath}`);
  deps.log("Running Attractor pipeline...");

  const runResult = await deps.runDot(dot, { cwd, now, llmClient, verbose: parsed.verbose });
  deps.log(`Run logs: ${runResult.logsRoot}`);
  if (runResult.status === "success") {
    deps.log(colorize("Pipeline completed successfully.", "green"));
    return 0;
  }
  deps.error(colorize("Pipeline failed.", "red"));
  return 1;
}

async function main(): Promise<void> {
  try {
    const code = await runCli(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}

const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
const currentFile = fileURLToPath(import.meta.url);
if (entryFile && path.resolve(currentFile) === entryFile) {
  await main();
}
