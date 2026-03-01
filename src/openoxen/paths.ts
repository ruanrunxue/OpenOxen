import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export interface OpenOxenPaths {
  home: string;
  configDir: string;
  memoryDir: string;
  skillsDir: string;
  logsDir: string;
  cacheDir: string;
  tmpDir: string;
  authFile: string;
  configFile: string;
  memoryFile: string;
}

function sanitizeSegment(input: string): string {
  const out = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return out || "workspace";
}

export function resolveOpenOxenHome(): string {
  const fromEnv = process.env.OPENOXEN_HOME?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  return path.join(os.homedir(), ".openoxen");
}

export function getOpenOxenPaths(): OpenOxenPaths {
  const home = resolveOpenOxenHome();
  const configDir = path.join(home, "config");
  const memoryDir = path.join(home, "memory");
  const skillsDir = path.join(home, "skills");
  const logsDir = path.join(home, "logs");
  const cacheDir = path.join(home, "cache");
  const tmpDir = path.join(home, "tmp");
  return {
    home,
    configDir,
    memoryDir,
    skillsDir,
    logsDir,
    cacheDir,
    tmpDir,
    authFile: path.join(configDir, "auth.json"),
    configFile: path.join(configDir, "config.json"),
    memoryFile: path.join(memoryDir, "global.md"),
  };
}

export async function ensureOpenOxenLayout(): Promise<OpenOxenPaths> {
  const layout = getOpenOxenPaths();
  await fs.mkdir(layout.home, { recursive: true });
  await fs.mkdir(layout.configDir, { recursive: true });
  await fs.mkdir(layout.memoryDir, { recursive: true });
  await fs.mkdir(layout.skillsDir, { recursive: true });
  await fs.mkdir(layout.logsDir, { recursive: true });
  await fs.mkdir(layout.cacheDir, { recursive: true });
  await fs.mkdir(layout.tmpDir, { recursive: true });
  return layout;
}

function projectScope(cwd: string): string {
  const base = sanitizeSegment(path.basename(path.resolve(cwd)));
  const hash = createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export function resolvePipelineLogsRoot(cwd: string, runId: string): string {
  const scope = projectScope(cwd);
  const { logsDir } = getOpenOxenPaths();
  return path.join(logsDir, scope, runId);
}

