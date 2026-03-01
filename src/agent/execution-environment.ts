import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { DirEntry, ExecResult, ExecutionEnvironment } from "./types.ts";

const SENSITIVE_ENV = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)/i;
const ALWAYS_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "GOPATH",
  "CARGO_HOME",
  "NVM_DIR",
  "PYTHONPATH",
]);

function isAbsolute(filePath: string): boolean {
  return path.isAbsolute(filePath);
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    const next = glob[i + 1] ?? "";
    if (ch === "*" && next === "*") {
      out += ".*";
      i += 1;
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += ".";
      continue;
    }
    if ("/.+()[]{}^$|\\".includes(ch)) {
      out += `\\${ch}`;
      continue;
    }
    out += ch;
  }
  out += "$";
  return new RegExp(out);
}

async function walk(base: string, depth: number, current = 0): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(base, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(base, entry.name);
    out.push(full);
    if (entry.isDirectory() && current < depth) {
      out.push(...(await walk(full, depth, current + 1)));
    }
  }
  return out;
}

interface LocalExecutionEnvironmentOptions {
  workingDir: string;
}

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  #workingDir: string;

  constructor(options: LocalExecutionEnvironmentOptions) {
    this.#workingDir = path.resolve(options.workingDir);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.#workingDir, { recursive: true });
  }

  async cleanup(): Promise<void> {}

  workingDirectory(): string {
    return this.#workingDir;
  }

  platform(): string {
    return process.platform;
  }

  osVersion(): string {
    return os.release();
  }

  #resolve(filePath: string): string {
    if (isAbsolute(filePath)) {
      return filePath;
    }
    return path.resolve(this.#workingDir, filePath);
  }

  async readFile(filePath: string, offset?: number | null, limit?: number | null): Promise<string> {
    const full = this.#resolve(filePath);
    const content = await fs.readFile(full, "utf8");
    const lines = content.split("\n");
    const start = Math.max(1, offset ?? 1);
    const max = Math.max(1, limit ?? 2000);
    const sliced = lines.slice(start - 1, start - 1 + max);
    return sliced.map((line, idx) => `${String(start + idx).padStart(4, " ")} | ${line}`).join("\n");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const full = this.#resolve(filePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(this.#resolve(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async listDirectory(dirPath: string, depth: number): Promise<DirEntry[]> {
    const full = this.#resolve(dirPath);
    const items = await walk(full, depth);
    const entries: DirEntry[] = [];
    for (const item of items) {
      const stat = await fs.stat(item);
      entries.push({
        name: path.relative(full, item),
        is_dir: stat.isDirectory(),
        size: stat.isDirectory() ? null : stat.size,
      });
    }
    return entries;
  }

  #filteredEnv(extra: Record<string, string> | null | undefined): Record<string, string> {
    const base: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) {
        continue;
      }
      if (SENSITIVE_ENV.test(key) && !ALWAYS_ALLOW.has(key)) {
        continue;
      }
      base[key] = value;
    }
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        base[key] = value;
      }
    }
    return base;
  }

  async execCommand(
    command: string,
    timeoutMs: number,
    workingDir?: string | null,
    envVars?: Record<string, string> | null,
  ): Promise<ExecResult> {
    const cwd = workingDir ? this.#resolve(workingDir) : this.#workingDir;
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/bash";
    const args = process.platform === "win32" ? ["/c", command] : ["-lc", command];
    const start = Date.now();

    return new Promise((resolve) => {
      const child = spawn(shell, args, {
        cwd,
        env: this.#filteredEnv(envVars),
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const terminate = () => {
        if (child.exitCode !== null) {
          return;
        }
        timedOut = true;
        if (process.platform === "win32") {
          child.kill("SIGTERM");
          return;
        }
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
        }, 2000);
      };

      killTimer = setTimeout(terminate, timeoutMs);
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (error) => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
        resolve({
          stdout,
          stderr: `${stderr}\n${String(error)}`,
          exit_code: 1,
          timed_out: timedOut,
          duration_ms: Date.now() - start,
        });
      });
      child.on("close", (code) => {
        if (killTimer) {
          clearTimeout(killTimer);
        }
        resolve({
          stdout,
          stderr: timedOut
            ? `${stderr}\n[ERROR: Command timed out after ${timeoutMs}ms. Partial output is shown above.\nYou can retry with a longer timeout by setting the timeout_ms parameter.]`
            : stderr,
          exit_code: code ?? 1,
          timed_out: timedOut,
          duration_ms: Date.now() - start,
        });
      });
    });
  }

  async grep(pattern: string, targetPath: string, options?: Record<string, unknown>): Promise<string> {
    const startPath = this.#resolve(targetPath || ".");
    const caseInsensitive = Boolean(options?.case_insensitive);
    const maxResults = Number(options?.max_results ?? 100);
    const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
    const files = await walk(startPath, 20);
    const lines: string[] = [];
    for (const file of files) {
      const stat = await fs.stat(file);
      if (stat.isDirectory()) {
        continue;
      }
      try {
        const content = await fs.readFile(file, "utf8");
        const split = content.split("\n");
        split.forEach((line, idx) => {
          if (regex.test(line)) {
            lines.push(`${path.relative(this.#workingDir, file)}:${idx + 1}:${line}`);
          }
        });
      } catch {
        continue;
      }
      if (lines.length >= maxResults) {
        break;
      }
    }
    return lines.slice(0, maxResults).join("\n");
  }

  async glob(pattern: string, targetPath: string): Promise<string[]> {
    const startPath = this.#resolve(targetPath || ".");
    const regex = globToRegExp(pattern);
    const all = await walk(startPath, 20);
    const matches: string[] = [];
    for (const full of all) {
      const rel = path.relative(startPath, full).replaceAll(path.sep, "/");
      if (regex.test(rel)) {
        matches.push(path.resolve(full));
      }
    }
    return matches.sort();
  }
}

