import fs from "node:fs/promises";
import path from "node:path";

import { DefaultToolRegistry } from "./tool-registry.ts";
import type {
  ExecutionEnvironment,
  ProviderProfile,
  RegisteredTool,
  SessionToolContext,
  ToolDefinition,
} from "./types.ts";

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required };
}

function lineCount(value: string): number {
  if (!value) {
    return 0;
  }
  return value.split("\n").length;
}

function makeCoreTools(): RegisteredTool[] {
  return [
    {
      definition: {
        name: "read_file",
        description: "Read a file with line-numbered output.",
        parameters: schema(
          {
            file_path: { type: "string" },
            offset: { type: "integer" },
            limit: { type: "integer" },
          },
          ["file_path"],
        ),
      },
      async execute(args, env) {
        return env.readFile(
          String(args.file_path),
          args.offset as number | undefined,
          args.limit as number | undefined,
        );
      },
    },
    {
      definition: {
        name: "write_file",
        description: "Write full content to a file.",
        parameters: schema(
          {
            file_path: { type: "string" },
            content: { type: "string" },
          },
          ["file_path", "content"],
        ),
      },
      async execute(args, env) {
        await env.writeFile(String(args.file_path), String(args.content));
        return `Wrote ${String(args.content).length} bytes to ${String(args.file_path)}`;
      },
    },
    {
      definition: {
        name: "edit_file",
        description: "Replace exact old_string with new_string in a file.",
        parameters: schema(
          {
            file_path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          ["file_path", "old_string", "new_string"],
        ),
      },
      async execute(args, env) {
        const filePath = String(args.file_path);
        const oldString = String(args.old_string);
        const newString = String(args.new_string);
        const replaceAll = Boolean(args.replace_all ?? false);
        const text = await env.readFile(filePath, 1, 10_000_000);
        const stripped = text
          .split("\n")
          .map((line) => line.replace(/^\s*\d+\s\|\s/, ""))
          .join("\n");
        const matches = stripped.split(oldString).length - 1;
        if (matches === 0) {
          throw new Error("old_string not found");
        }
        if (!replaceAll && matches > 1) {
          throw new Error("old_string not unique; set replace_all=true");
        }
        const updated = replaceAll ? stripped.split(oldString).join(newString) : stripped.replace(oldString, newString);
        await env.writeFile(filePath, updated);
        return `Replaced ${replaceAll ? matches : 1} occurrence(s)`;
      },
    },
    {
      definition: {
        name: "shell",
        description: "Execute a shell command.",
        parameters: schema(
          {
            command: { type: "string" },
            timeout_ms: { type: "integer" },
            description: { type: "string" },
          },
          ["command"],
        ),
      },
      async execute(args, env) {
        const timeout = Number(args.timeout_ms ?? 10_000);
        const result = await env.execCommand(String(args.command), timeout);
        return [
          result.stdout,
          result.stderr,
          `\n[exit_code=${result.exit_code} duration_ms=${result.duration_ms} timed_out=${String(result.timed_out)}]`,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      definition: {
        name: "grep",
        description: "Search file contents by regex.",
        parameters: schema(
          {
            pattern: { type: "string" },
            path: { type: "string" },
            case_insensitive: { type: "boolean" },
            max_results: { type: "integer" },
          },
          ["pattern"],
        ),
      },
      async execute(args, env) {
        return env.grep(String(args.pattern), String(args.path ?? "."), args);
      },
    },
    {
      definition: {
        name: "glob",
        description: "Find files matching a glob pattern.",
        parameters: schema(
          {
            pattern: { type: "string" },
            path: { type: "string" },
          },
          ["pattern"],
        ),
      },
      async execute(args, env) {
        const files = await env.glob(String(args.pattern), String(args.path ?? "."));
        return files.join("\n");
      },
    },
    {
      definition: {
        name: "read",
        description: "Read a file. Alias of read_file.",
        parameters: schema(
          {
            path: { type: "string" },
            file_path: { type: "string" },
            offset: { type: "integer" },
            limit: { type: "integer" },
          },
          [],
        ),
      },
      async execute(args, env) {
        const filePath = String(args.path ?? args.file_path ?? "");
        if (!filePath) {
          throw new Error("path is required");
        }
        return env.readFile(filePath, args.offset as number | undefined, args.limit as number | undefined);
      },
    },
    {
      definition: {
        name: "write",
        description: "Write full content to a file. Alias of write_file.",
        parameters: schema(
          {
            path: { type: "string" },
            file_path: { type: "string" },
            content: { type: "string" },
          },
          ["content"],
        ),
      },
      async execute(args, env) {
        const filePath = String(args.path ?? args.file_path ?? "");
        if (!filePath) {
          throw new Error("path is required");
        }
        await env.writeFile(filePath, String(args.content));
        return `Wrote ${String(args.content).length} bytes to ${filePath}`;
      },
    },
    {
      definition: {
        name: "edit",
        description: "Replace old_string with new_string in a file. Alias of edit_file.",
        parameters: schema(
          {
            path: { type: "string" },
            file_path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          ["old_string", "new_string"],
        ),
      },
      async execute(args, env) {
        const filePath = String(args.path ?? args.file_path ?? "");
        if (!filePath) {
          throw new Error("path is required");
        }
        const oldString = String(args.old_string);
        const newString = String(args.new_string);
        const replaceAll = Boolean(args.replace_all ?? false);
        const text = await env.readFile(filePath, 1, 10_000_000);
        const stripped = text
          .split("\n")
          .map((line) => line.replace(/^\s*\d+\s\|\s/, ""))
          .join("\n");
        const matches = stripped.split(oldString).length - 1;
        if (matches === 0) {
          throw new Error("old_string not found");
        }
        if (!replaceAll && matches > 1) {
          throw new Error("old_string not unique; set replace_all=true");
        }
        const updated = replaceAll ? stripped.split(oldString).join(newString) : stripped.replace(oldString, newString);
        await env.writeFile(filePath, updated);
        return `Replaced ${replaceAll ? matches : 1} occurrence(s)`;
      },
    },
    {
      definition: {
        name: "ls",
        description: "List directory entries with type and size.",
        parameters: schema(
          {
            path: { type: "string" },
            depth: { type: "integer" },
          },
          [],
        ),
      },
      async execute(args, env) {
        const list = await env.listDirectory(String(args.path ?? "."), Number(args.depth ?? 1));
        return list
          .map((entry) => {
            const kind = entry.is_dir ? "d" : "f";
            const size = entry.size ?? 0;
            return `${kind}\t${size}\t${entry.name}`;
          })
          .join("\n");
      },
    },
    {
      definition: {
        name: "list_dir",
        description: "List directory entries. Alias of ls.",
        parameters: schema(
          {
            path: { type: "string" },
            depth: { type: "integer" },
          },
          [],
        ),
      },
      async execute(args, env) {
        const list = await env.listDirectory(String(args.path ?? "."), Number(args.depth ?? 1));
        return list
          .map((entry) => {
            const kind = entry.is_dir ? "d" : "f";
            const size = entry.size ?? 0;
            return `${kind}\t${size}\t${entry.name}`;
          })
          .join("\n");
      },
    },
    {
      definition: {
        name: "find",
        description: "Find files by glob pattern. Alias of glob.",
        parameters: schema(
          {
            pattern: { type: "string" },
            path: { type: "string" },
          },
          ["pattern"],
        ),
      },
      async execute(args, env) {
        const files = await env.glob(String(args.pattern), String(args.path ?? "."));
        return files.join("\n");
      },
    },
    {
      definition: {
        name: "search",
        description: "Search text by regex. Alias of grep.",
        parameters: schema(
          {
            pattern: { type: "string" },
            path: { type: "string" },
            case_insensitive: { type: "boolean" },
            max_results: { type: "integer" },
          },
          ["pattern"],
        ),
      },
      async execute(args, env) {
        return env.grep(String(args.pattern), String(args.path ?? "."), args);
      },
    },
    {
      definition: {
        name: "exec",
        description: "Execute shell command. Alias of shell.",
        parameters: schema(
          {
            cmd: { type: "string" },
            command: { type: "string" },
            timeout_ms: { type: "integer" },
          },
          [],
        ),
      },
      async execute(args, env) {
        const command = String(args.command ?? args.cmd ?? "");
        if (!command) {
          throw new Error("command is required");
        }
        const timeout = Number(args.timeout_ms ?? 10_000);
        const result = await env.execCommand(command, timeout);
        return [
          result.stdout,
          result.stderr,
          `\n[exit_code=${result.exit_code} duration_ms=${result.duration_ms} timed_out=${String(result.timed_out)}]`,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      definition: {
        name: "bash",
        description: "Execute shell command via bash. Alias of exec.",
        parameters: schema(
          {
            cmd: { type: "string" },
            command: { type: "string" },
            timeout_ms: { type: "integer" },
          },
          [],
        ),
      },
      async execute(args, env) {
        const command = String(args.command ?? args.cmd ?? "");
        if (!command) {
          throw new Error("command is required");
        }
        const timeout = Number(args.timeout_ms ?? 10_000);
        const result = await env.execCommand(command, timeout);
        return [
          result.stdout,
          result.stderr,
          `\n[exit_code=${result.exit_code} duration_ms=${result.duration_ms} timed_out=${String(result.timed_out)}]`,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      definition: {
        name: "process",
        description: "Process command helper. Uses foreground execution in this runtime.",
        parameters: schema(
          {
            action: { type: "string", description: "run|status|wait|stop; run is supported." },
            cmd: { type: "string" },
            command: { type: "string" },
            timeout_ms: { type: "integer" },
          },
          [],
        ),
      },
      async execute(args, env) {
        const action = String(args.action ?? "run").toLowerCase();
        if (action !== "run") {
          return `Action '${action}' is not supported in LocalExecutionEnvironment. Use action=run.`;
        }
        const command = String(args.command ?? args.cmd ?? "");
        if (!command) {
          throw new Error("command is required when action=run");
        }
        const timeout = Number(args.timeout_ms ?? 10_000);
        const result = await env.execCommand(command, timeout);
        return [
          result.stdout,
          result.stderr,
          `\n[exit_code=${result.exit_code} duration_ms=${result.duration_ms} timed_out=${String(result.timed_out)}]`,
        ]
          .filter(Boolean)
          .join("\n");
      },
    },
    {
      definition: {
        name: "apply_patch",
        description: "Apply patch in v4a format (minimal implementation).",
        parameters: schema({ patch: { type: "string" } }, ["patch"]),
      },
      async execute(args, env) {
        const patch = String(args.patch);
        if (!patch.includes("*** Begin Patch") || !patch.includes("*** End Patch")) {
          throw new Error("Invalid patch format");
        }
        const lines = patch.split("\n");
        const touched: string[] = [];
        let currentFile: string | null = null;
        let mode: "add" | "update" | null = null;
        const adds: string[] = [];
        for (const line of lines) {
          if (line.startsWith("*** Add File: ")) {
            currentFile = line.slice("*** Add File: ".length).trim();
            mode = "add";
            adds.length = 0;
            continue;
          }
          if (line.startsWith("*** Update File: ")) {
            currentFile = line.slice("*** Update File: ".length).trim();
            mode = "update";
            continue;
          }
          if (line.startsWith("*** ")) {
            if (mode === "add" && currentFile) {
              await env.writeFile(currentFile, `${adds.join("\n")}\n`);
              touched.push(currentFile);
            }
            currentFile = null;
            mode = null;
            continue;
          }
          if (mode === "add" && line.startsWith("+")) {
            adds.push(line.slice(1));
          }
        }
        if (mode === "add" && currentFile) {
          await env.writeFile(currentFile, `${adds.join("\n")}\n`);
          touched.push(currentFile);
        }
        if (!touched.length) {
          return "Patch parsed (no file updates performed by minimal engine)";
        }
        return `Patched files:\n${touched.join("\n")}`;
      },
    },
    {
      definition: {
        name: "spawn_agent",
        description: "Spawn a subagent for a scoped task.",
        parameters: schema(
          {
            task: { type: "string" },
            working_dir: { type: "string" },
            model: { type: "string" },
            max_turns: { type: "integer" },
          },
          ["task"],
        ),
      },
      async execute(args, _env, sessionCtx) {
        if (!sessionCtx) {
          throw new Error("Subagent context unavailable");
        }
        return sessionCtx.spawnSubAgent(args);
      },
    },
    {
      definition: {
        name: "send_input",
        description: "Send input to a running subagent.",
        parameters: schema({ agent_id: { type: "string" }, message: { type: "string" } }, ["agent_id", "message"]),
      },
      async execute(args, _env, sessionCtx) {
        if (!sessionCtx) {
          throw new Error("Subagent context unavailable");
        }
        return sessionCtx.sendSubAgentInput(args);
      },
    },
    {
      definition: {
        name: "wait",
        description: "Wait for a subagent to complete.",
        parameters: schema({ agent_id: { type: "string" } }, ["agent_id"]),
      },
      async execute(args, _env, sessionCtx) {
        if (!sessionCtx) {
          throw new Error("Subagent context unavailable");
        }
        return sessionCtx.waitSubAgent(args);
      },
    },
    {
      definition: {
        name: "close_agent",
        description: "Close a subagent.",
        parameters: schema({ agent_id: { type: "string" } }, ["agent_id"]),
      },
      async execute(args, _env, sessionCtx) {
        if (!sessionCtx) {
          throw new Error("Subagent context unavailable");
        }
        return sessionCtx.closeSubAgent(args);
      },
    },
  ];
}

async function discoverProjectDocs(environment: ExecutionEnvironment, provider: string): Promise<string> {
  const cwd = environment.workingDirectory();
  const rootCandidates = [cwd];
  const files = ["AGENTS.md"];
  if (provider === "anthropic") {
    files.push("CLAUDE.md");
  }
  if (provider === "gemini") {
    files.push("GEMINI.md");
  }
  if (provider === "openai") {
    files.push(".codex/instructions.md");
  }
  const chunks: string[] = [];
  for (const root of rootCandidates) {
    for (const file of files) {
      const full = path.join(root, file);
      try {
        const data = await fs.readFile(full, "utf8");
        chunks.push(`\n# ${file}\n${data}`);
      } catch {}
    }
  }
  const joined = chunks.join("\n");
  const limit = 32 * 1024;
  if (joined.length > limit) {
    return `${joined.slice(0, limit)}\n[Project instructions truncated at 32KB]`;
  }
  return joined;
}

function envBlock(environment: ExecutionEnvironment, model: string): string {
  return [
    "<environment>",
    `Working directory: ${environment.workingDirectory()}`,
    "Is git repository: unknown",
    "Git branch: unknown",
    `Platform: ${environment.platform()}`,
    `OS version: ${environment.osVersion()}`,
    `Today's date: ${new Date().toISOString().slice(0, 10)}`,
    `Model: ${model}`,
    "Knowledge cutoff: unknown",
    "</environment>",
  ].join("\n");
}

function makeProfile(params: {
  id: string;
  model: string;
  supports_parallel_tool_calls: boolean;
  basePrompt: string;
}): ProviderProfile {
  const registry = new DefaultToolRegistry();
  for (const tool of makeCoreTools()) {
    registry.register(tool);
  }
  return {
    id: params.id,
    model: params.model,
    toolRegistry: registry,
    async buildSystemPrompt(environment, projectDocs) {
      const docs = projectDocs || (await discoverProjectDocs(environment, params.id));
      const tools = registry
        .definitions()
        .map((d) => `- ${d.name}: ${d.description}`)
        .join("\n");
      return `${params.basePrompt}\n\n${envBlock(environment, params.model)}\n\n<Tools>\n${tools}\n</Tools>\n\n${docs}`;
    },
    tools() {
      return registry.definitions();
    },
    providerOptions() {
      return null;
    },
    supports_reasoning: true,
    supports_streaming: false,
    supports_parallel_tool_calls: params.supports_parallel_tool_calls,
    context_window_size: 200_000,
  };
}

export function createOpenAIProfile(model = "gpt-5.2-codex"): ProviderProfile {
  return makeProfile({
    id: "openai",
    model,
    supports_parallel_tool_calls: true,
    basePrompt:
      "You are a coding assistant aligned to codex-rs behavior. Prefer apply_patch for structured edits and use tools carefully.",
  });
}

export function createAnthropicProfile(model = "claude-sonnet-4-5"): ProviderProfile {
  return makeProfile({
    id: "anthropic",
    model,
    supports_parallel_tool_calls: false,
    basePrompt:
      "You are a coding assistant aligned to Claude Code behavior. Prefer read before edit and use edit_file with exact old_string.",
  });
}

export function createGeminiProfile(model = "gemini-2.5-pro"): ProviderProfile {
  return makeProfile({
    id: "gemini",
    model,
    supports_parallel_tool_calls: true,
    basePrompt:
      "You are a coding assistant aligned to gemini-cli behavior. Use tools precisely and keep responses actionable.",
  });
}

export async function buildProjectDocs(environment: ExecutionEnvironment, provider: string): Promise<string> {
  return discoverProjectDocs(environment, provider);
}

export function summarizeToolDefinitions(defs: ToolDefinition[]): string {
  return `Tool count: ${defs.length}, total description lines: ${defs.reduce((n, d) => n + lineCount(d.description), 0)}`;
}

export function createCustomToolProfile(
  base: ProviderProfile,
  customTools: RegisteredTool[],
): ProviderProfile {
  for (const tool of customTools) {
    base.toolRegistry.register(tool);
  }
  return base;
}
