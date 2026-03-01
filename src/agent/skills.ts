import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { getOpenOxenPaths } from "../openoxen/paths.ts";

export interface SkillFileInfo {
  path: string;
  absolute_path: string;
  size: number;
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  directory: string;
  skill_file: string;
  instructions: string;
  metadata: Record<string, unknown>;
  files: SkillFileInfo[];
}

export interface SkillCatalog {
  roots: string[];
  skills: AgentSkill[];
  errors: string[];
}

export interface DiscoverSkillsOptions {
  cwd: string;
  roots?: string[];
  maxFilesPerSkill?: number;
  maxBytesPerFile?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function sanitizeSkillId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parseFrontmatter(raw: string): { metadata: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---\n")) {
    return { metadata: {}, body: raw };
  }
  const closing = raw.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { metadata: {}, body: raw };
  }
  const head = raw.slice(4, closing).trim();
  const body = raw.slice(closing + 5);
  const metadata: Record<string, unknown> = {};
  for (const line of head.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      const items = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .map((item) => item.replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      metadata[key] = items;
      continue;
    }
    metadata[key] = value;
  }
  return { metadata, body };
}

function firstBodyLine(body: string): string {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    if (t.startsWith("#")) {
      continue;
    }
    return t.slice(0, 240);
  }
  return "";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function tryReadJson(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function listFiles(baseDir: string, maxFiles: number): Promise<SkillFileInfo[]> {
  const out: SkillFileInfo[] = [];
  const queue = [baseDir];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") {
          continue;
        }
        queue.push(full);
        continue;
      }
      const stat = await fs.stat(full);
      out.push({
        path: path.relative(baseDir, full).replaceAll(path.sep, "/"),
        absolute_path: full,
        size: stat.size,
      });
      if (out.length >= maxFiles) {
        return out.sort((a, b) => a.path.localeCompare(b.path));
      }
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

async function findSkillDirectories(root: string): Promise<string[]> {
  const out: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.shift()!;
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hasSkillMd = entries.some(
      (entry) => entry.isFile() && (entry.name === "SKILL.md" || entry.name === "skill.md"),
    );
    if (hasSkillMd) {
      out.push(dir);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      queue.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function resolveRoots(cwd: string, explicitRoots?: string[]): string[] {
  if (explicitRoots && explicitRoots.length > 0) {
    return explicitRoots.map((root) => path.resolve(cwd, root));
  }
  const fromEnv = process.env.OPENOXEN_SKILLS_DIRS;
  const roots: string[] = [];
  if (fromEnv?.trim()) {
    for (const part of fromEnv.split(path.delimiter)) {
      const trimmed = part.trim();
      if (!trimmed) {
        continue;
      }
      roots.push(path.resolve(cwd, trimmed));
    }
    return [...new Set(roots)];
  }

  roots.push(getOpenOxenPaths().skillsDir);
  if (process.env.OPENOXEN_ENABLE_HOME_SKILLS === "1") {
    const home = os.homedir();
    roots.push(path.join(home, ".codex", "skills"));
    roots.push(path.join(home, ".codex", "superpowers", "skills"));
  }
  return [...new Set(roots)];
}

export async function discoverSkills(options: DiscoverSkillsOptions): Promise<SkillCatalog> {
  const roots = resolveRoots(options.cwd, options.roots);
  const maxFilesPerSkill = Math.max(1, Number(options.maxFilesPerSkill ?? 64));
  const maxBytesPerFile = Math.max(1, Number(options.maxBytesPerFile ?? 256_000));
  const skills: AgentSkill[] = [];
  const errors: string[] = [];

  for (const root of roots) {
    if (!(await fileExists(root))) {
      continue;
    }
    const skillDirs = await findSkillDirectories(root);
    for (const dir of skillDirs) {
      try {
        const upper = path.join(dir, "SKILL.md");
        const lower = path.join(dir, "skill.md");
        const skillFile = (await fileExists(upper)) ? upper : lower;
        const raw = await fs.readFile(skillFile, "utf8");
        const { metadata: frontmatter, body } = parseFrontmatter(raw);
        const metaJson =
          (await tryReadJson(path.join(dir, "skill.json"))) ?? (await tryReadJson(path.join(dir, "agent-skill.json")));
        const metadata = { ...metaJson, ...frontmatter };
        const fileInfos = await listFiles(dir, maxFilesPerSkill);

        const instructions = body.length > maxBytesPerFile ? `${body.slice(0, maxBytesPerFile)}\n[truncated]` : body;
        const name = String(metadata.name ?? path.basename(dir));
        const id = sanitizeSkillId(String(metadata.id ?? metadata.slug ?? name ?? path.basename(dir)));
        if (!id) {
          continue;
        }
        const descriptionRaw = String(metadata.description ?? firstBodyLine(body) ?? "");
        const description = descriptionRaw.slice(0, 500);

        skills.push({
          id,
          name,
          description,
          directory: dir,
          skill_file: skillFile,
          instructions,
          metadata,
          files: fileInfos,
        });
      } catch (error) {
        errors.push(`Failed to load skill ${dir}: ${String(error)}`);
      }
    }
  }

  skills.sort((a, b) => a.id.localeCompare(b.id));
  return { roots, skills, errors };
}

function scoreSkill(skill: AgentSkill, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    return 0;
  }
  let score = 0;
  const name = skill.name.toLowerCase();
  const id = skill.id.toLowerCase();
  const desc = skill.description.toLowerCase();
  const body = skill.instructions.slice(0, 2000).toLowerCase();
  if (name === q || id === q) {
    score += 100;
  }
  if (name.includes(q)) {
    score += 30;
  }
  if (id.includes(q)) {
    score += 25;
  }
  if (desc.includes(q)) {
    score += 20;
  }
  if (body.includes(q)) {
    score += 10;
  }
  for (const token of q.split(/\s+/).filter(Boolean)) {
    if (name.includes(token)) {
      score += 8;
    }
    if (desc.includes(token)) {
      score += 4;
    }
    if (body.includes(token)) {
      score += 2;
    }
  }
  return score;
}

export function searchSkills(catalog: SkillCatalog, query: string, limit = 10): AgentSkill[] {
  const capped = Math.max(1, Math.min(50, Number(limit || 10)));
  const scored = catalog.skills
    .map((skill) => ({ skill, score: scoreSkill(skill, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  return scored.slice(0, capped).map((entry) => entry.skill);
}

export function getSkillById(catalog: SkillCatalog, value: string): AgentSkill | undefined {
  const lookup = sanitizeSkillId(value);
  if (!lookup) {
    return undefined;
  }
  return catalog.skills.find((skill) => skill.id === lookup || sanitizeSkillId(skill.name) === lookup);
}

export async function readSkillFile(skill: AgentSkill, filePath: string, maxBytes = 256_000): Promise<string> {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "");
  const file = skill.files.find((f) => f.path === normalized);
  if (!file) {
    throw new Error(`Skill file not found: ${filePath}`);
  }
  const raw = await fs.readFile(file.absolute_path, "utf8");
  if (raw.length > maxBytes) {
    return `${raw.slice(0, maxBytes)}\n[truncated]`;
  }
  return raw;
}
