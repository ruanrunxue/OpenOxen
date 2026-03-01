import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { discoverSkills, getSkillById, readSkillFile, searchSkills, type SkillCatalog } from "../agent/index.ts";
import { createPiAiClientAdapterFromEnv, loginPiWithOauthFromEnv, type LLMClient } from "../llm-client/pi-ai.ts";
import { getOpenOxenPaths } from "../openoxen/paths.ts";
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
  discoverSkillsCatalog: (cwd: string) => Promise<SkillCatalog>;
  listRemoteSkills: () => Promise<Array<{ name: string; installed?: boolean; repo: string; path: string; ref: string }>>;
  installSkillFromSource: (params: {
    url?: string;
    repo?: string;
    path?: string;
    dest: string;
    ref?: string;
    name?: string;
    method?: "auto" | "download" | "git";
  }) => Promise<{ stdout: string }>;
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
    "  openoxen skills list [--query <text>] [--limit <n>] [--json]",
    "  openoxen skills get <id> [--file <path>] [--include-files] [--max-chars <n>] [--json]",
    "  openoxen skills install <github-url|skill-name> [--dest <dir>] [--json]",
    "",
    "Examples:",
    "  openoxen dev \"实现用户登录\"",
    "  openoxen dev \"实现支付接口\" --task payment-api --quiet",
    "  openoxen login",
    "  openoxen skills list --query snake",
    "  openoxen skills get snake-game",
    "  openoxen skills install snake-game",
    "  openoxen skills install https://github.com/openai/skills/tree/main/skills/.curated/doc",
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

interface SkillsListArgs {
  query: string;
  limit: number;
  json: boolean;
  error?: string;
}

interface SkillsGetArgs {
  id: string;
  filePath?: string;
  includeFiles: boolean;
  maxChars: number;
  json: boolean;
  error?: string;
}

interface SkillsInstallArgs {
  source: string;
  dest?: string;
  json: boolean;
  error?: string;
}

function looksLikeGithubUrl(value: string): boolean {
  return /^https?:\/\/github\.com\//i.test(value.trim());
}

function resolveDefaultInstallDest(): string {
  return getOpenOxenPaths().skillsDir;
}

function scoreSkillName(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (!q || !c) {
    return 0;
  }
  if (q === c) {
    return 100;
  }
  if (c.startsWith(q)) {
    return 75;
  }
  if (c.includes(q)) {
    return 50;
  }
  const parts = q.split(/[-_\s]+/).filter(Boolean);
  let score = 0;
  for (const part of parts) {
    if (c.includes(part)) {
      score += 10;
    }
  }
  return score;
}

function pickBestSkillMatch(
  query: string,
  candidates: Array<{ name: string; installed?: boolean; repo: string; path: string; ref: string }>,
): {
  chosen?: { name: string; installed?: boolean; repo: string; path: string; ref: string };
  ambiguous: Array<{ name: string; installed?: boolean; repo: string; path: string; ref: string }>;
} {
  const scored = candidates
    .map((item) => ({ item, score: scoreSkillName(query, item.name) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
  if (scored.length === 0) {
    return { chosen: undefined, ambiguous: [] };
  }
  const topScore = scored[0]!.score;
  const top = scored.filter((row) => row.score === topScore).map((row) => row.item);
  if (top.length === 1) {
    return { chosen: top[0], ambiguous: [] };
  }
  return { chosen: undefined, ambiguous: top.slice(0, 8) };
}

function parseSkillsListArgs(args: string[]): SkillsListArgs {
  let query = "";
  let limit = 20;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--query") {
      const next = args[i + 1];
      if (!next) {
        return { query, limit, json, error: "Missing value for --query" };
      }
      query = next;
      i += 1;
      continue;
    }
    if (token === "--limit") {
      const next = args[i + 1];
      if (!next) {
        return { query, limit, json, error: "Missing value for --limit" };
      }
      limit = Math.max(1, Math.min(200, Number(next)));
      i += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    return { query, limit, json, error: `Unknown argument for skills list: ${token}` };
  }
  return { query, limit, json };
}

function parseSkillsGetArgs(args: string[]): SkillsGetArgs {
  let id = "";
  let filePath: string | undefined;
  let includeFiles = false;
  let maxChars = 120_000;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith("--") && !id) {
      id = token;
      continue;
    }
    if (token === "--file") {
      const next = args[i + 1];
      if (!next) {
        return { id, filePath, includeFiles, maxChars, json, error: "Missing value for --file" };
      }
      filePath = next;
      i += 1;
      continue;
    }
    if (token === "--include-files") {
      includeFiles = true;
      continue;
    }
    if (token === "--max-chars") {
      const next = args[i + 1];
      if (!next) {
        return { id, filePath, includeFiles, maxChars, json, error: "Missing value for --max-chars" };
      }
      maxChars = Math.max(256, Math.min(1_000_000, Number(next)));
      i += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    return { id, filePath, includeFiles, maxChars, json, error: `Unknown argument for skills get: ${token}` };
  }
  if (!id) {
    return { id, filePath, includeFiles, maxChars, json, error: "Missing skill id" };
  }
  return { id, filePath, includeFiles, maxChars, json };
}

function parseSkillsInstallArgs(args: string[]): SkillsInstallArgs {
  let source = "";
  let dest: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (!token.startsWith("--") && !source) {
      source = token;
      continue;
    }
    if (token === "--dest") {
      const next = args[i + 1];
      if (!next) {
        return { source, dest, json, error: "Missing value for --dest" };
      }
      dest = next;
      i += 1;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    return { source, dest, json, error: `Unknown argument for skills install: ${token}` };
  }
  if (!source.trim()) {
    return { source, dest, json, error: "Missing install source (github-url or skill-name)" };
  }
  return { source, dest, json };
}

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function execCommand(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      }),
    );
  });
}

function skillInstallerScriptsDir(): string {
  if (process.env.OPENOXEN_SKILL_INSTALLER_DIR?.trim()) {
    return process.env.OPENOXEN_SKILL_INSTALLER_DIR.trim();
  }
  return path.join(os.homedir(), ".codex", "skills", ".system", "skill-installer", "scripts");
}

async function runSkillInstallerScript(args: string[]): Promise<ExecResult> {
  const scripts = skillInstallerScriptsDir();
  const script = path.join(scripts, args[0]!);
  const stat = await fs.stat(script).catch(() => null);
  if (!stat) {
    throw new Error(`Skill installer script not found: ${script}`);
  }
  return execCommand("python3", [script, ...args.slice(1)]);
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
    discoverSkillsCatalog: async (cwd) => discoverSkills({ cwd }),
    listRemoteSkills: async () => {
      const repo = "openai/skills";
      const ref = "main";
      const paths = ["skills/.curated", "skills/.experimental"];
      const out: Array<{ name: string; installed?: boolean; repo: string; path: string; ref: string }> = [];
      for (const p of paths) {
        const res = await runSkillInstallerScript(["list-skills.py", "--repo", repo, "--path", p, "--ref", ref, "--format", "json"]);
        if (res.exitCode !== 0) {
          if (p === "skills/.experimental") {
            continue;
          }
          throw new Error(res.stderr.trim() || "Failed to list remote skills");
        }
        let data: unknown;
        try {
          data = JSON.parse(res.stdout);
        } catch {
          throw new Error(`Invalid JSON from list-skills.py for path ${p}`);
        }
        if (!Array.isArray(data)) {
          throw new Error(`Unexpected list-skills.py output for path ${p}`);
        }
        for (const row of data) {
          if (typeof row !== "object" || row === null) {
            continue;
          }
          const name = String((row as { name?: unknown }).name ?? "").trim();
          if (!name) {
            continue;
          }
          out.push({
            name,
            installed: Boolean((row as { installed?: unknown }).installed),
            repo,
            path: `${p}/${name}`,
            ref,
          });
        }
      }
      return out;
    },
    installSkillFromSource: async (params) => {
      const args = ["install-skill-from-github.py"];
      if (params.url) {
        args.push("--url", params.url);
      } else {
        args.push("--repo", String(params.repo ?? ""));
      }
      if (params.path) {
        args.push("--path", params.path);
      }
      if (params.ref) {
        args.push("--ref", params.ref);
      }
      if (params.name) {
        args.push("--name", params.name);
      }
      if (params.method) {
        args.push("--method", params.method);
      }
      args.push("--dest", params.dest);

      const res = await runSkillInstallerScript(args);
      if (res.exitCode !== 0) {
        throw new Error(res.stderr.trim() || res.stdout.trim() || "Skill install failed");
      }
      return { stdout: res.stdout.trim() };
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

  if (command === "skills") {
    const [sub, ...skillArgs] = rest;
    const cwd = deps.cwd();
    const catalog = await deps.discoverSkillsCatalog(cwd);
    if (sub === "list") {
      const parsed = parseSkillsListArgs(skillArgs);
      if (parsed.error) {
        deps.error(parsed.error);
        deps.error(usage());
        return 1;
      }
      const hits = parsed.query.trim() ? searchSkills(catalog, parsed.query, parsed.limit) : catalog.skills.slice(0, parsed.limit);
      if (parsed.json) {
        deps.log(
          JSON.stringify(
            {
              total: catalog.skills.length,
              query: parsed.query,
              roots: catalog.roots,
              results: hits.map((skill) => ({
                id: skill.id,
                name: skill.name,
                description: skill.description,
                directory: skill.directory,
                file_count: skill.files.length,
              })),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      deps.log(`Skills: ${hits.length}/${catalog.skills.length}`);
      for (const skill of hits) {
        deps.log(`- ${skill.id}: ${skill.description || "(no description)"}`);
      }
      if (hits.length === 0) {
        deps.log("No skills found.");
      }
      return 0;
    }

    if (sub === "get") {
      const parsed = parseSkillsGetArgs(skillArgs);
      if (parsed.error) {
        deps.error(parsed.error);
        deps.error(usage());
        return 1;
      }
      const skill = getSkillById(catalog, parsed.id);
      if (!skill) {
        deps.error(`Skill not found: ${parsed.id}`);
        return 1;
      }

      let output = "";
      if (parsed.filePath) {
        const content = await readSkillFile(skill, parsed.filePath, parsed.maxChars);
        output = [`# ${skill.name}`, `id: ${skill.id}`, `file: ${parsed.filePath}`, "", content].join("\n");
      } else {
        const lines: string[] = [];
        lines.push(`# ${skill.name}`);
        lines.push(`id: ${skill.id}`);
        lines.push(`description: ${skill.description || "(none)"}`);
        lines.push(`directory: ${skill.directory}`);
        lines.push("");
        lines.push("## SKILL.md");
        lines.push(skill.instructions.slice(0, parsed.maxChars));
        if (parsed.includeFiles) {
          for (const file of skill.files) {
            if (file.path === "SKILL.md" || file.path === "skill.md") {
              continue;
            }
            const content = await readSkillFile(skill, file.path, parsed.maxChars);
            lines.push("");
            lines.push(`## File: ${file.path}`);
            lines.push(content);
          }
        }
        output = lines.join("\n");
      }

      if (parsed.json) {
        deps.log(
          JSON.stringify(
            {
              id: skill.id,
              name: skill.name,
              description: skill.description,
              directory: skill.directory,
              files: skill.files.map((file) => file.path),
              content: output,
            },
            null,
            2,
          ),
        );
      } else {
        deps.log(output);
      }
      return 0;
    }

    if (sub === "install") {
      const parsed = parseSkillsInstallArgs(skillArgs);
      if (parsed.error) {
        deps.error(parsed.error);
        deps.error(usage());
        return 1;
      }
      const dest = path.resolve(cwd, parsed.dest ?? resolveDefaultInstallDest());
      const source = parsed.source.trim();
      try {
        if (looksLikeGithubUrl(source)) {
          const out = await deps.installSkillFromSource({ url: source, dest });
          if (parsed.json) {
            deps.log(
              JSON.stringify(
                {
                  source_type: "url",
                  source,
                  destination: dest,
                  status: "ok",
                  output: out.stdout,
                },
                null,
                2,
              ),
            );
          } else {
            deps.log(out.stdout || `Installed from URL: ${source}`);
          }
          return 0;
        }

        const remoteSkills = await deps.listRemoteSkills();
        const { chosen, ambiguous } = pickBestSkillMatch(source, remoteSkills);
        if (!chosen) {
          if (ambiguous.length > 0) {
            deps.error(`Skill name is ambiguous: ${source}`);
            deps.error(`Candidates: ${ambiguous.map((item) => item.name).join(", ")}`);
          } else {
            deps.error(`No remote skill matched: ${source}`);
          }
          return 1;
        }
        const out = await deps.installSkillFromSource({
          repo: chosen.repo,
          path: chosen.path,
          ref: chosen.ref,
          dest,
        });
        if (parsed.json) {
          deps.log(
            JSON.stringify(
              {
                source_type: "name",
                requested: source,
                resolved: chosen.name,
                repo: chosen.repo,
                path: chosen.path,
                ref: chosen.ref,
                destination: dest,
                status: "ok",
                output: out.stdout,
              },
              null,
              2,
            ),
          );
        } else {
          deps.log(`Resolved skill '${source}' -> '${chosen.name}' (${chosen.path})`);
          deps.log(out.stdout || `Installed skill: ${chosen.name}`);
        }
        return 0;
      } catch (error) {
        deps.error(String(error));
        return 1;
      }
    }

    deps.error(`Unknown skills subcommand: ${String(sub ?? "")}`);
    deps.error(usage());
    return 1;
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
