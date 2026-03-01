import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LocalExecutionEnvironment } from "../src/agent/execution-environment.ts";
import { createOpenAIProfile } from "../src/agent/providers.ts";
import { Session } from "../src/agent/session.ts";
import { discoverSkills, searchSkills } from "../src/agent/skills.ts";

class FakeClient {
  #responses;
  #index = 0;

  constructor(responses) {
    this.#responses = responses;
  }

  async complete() {
    const out = this.#responses[this.#index] ?? { text: "done", tool_calls: [] };
    this.#index += 1;
    return out;
  }
}

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function writeSkill(
  homeRoot: string,
  dirName: string,
  skillMd: string,
  extraFiles: Array<{ relativePath: string; content: string }> = [],
): Promise<void> {
  const base = path.join(homeRoot, "skills", dirName);
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, "SKILL.md"), skillMd, "utf8");
  for (const file of extraFiles) {
    const full = path.join(base, file.relativePath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.content, "utf8");
  }
}

async function withOpenOxenHome<T>(homeRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENOXEN_HOME;
  process.env.OPENOXEN_HOME = homeRoot;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.OPENOXEN_HOME;
    } else {
      process.env.OPENOXEN_HOME = prev;
    }
  }
}

test("discoverSkills parses agentskills-style SKILL.md with frontmatter and files", async () => {
  const cwd = await mkTmpDir("openoxen-skills-discover");
  const home = path.join(cwd, ".home-openoxen");
  await withOpenOxenHome(home, async () => {
    await writeSkill(
      home,
      "snake-game",
      [
        "---",
        "name: snake-game",
        "description: Build a browser snake game with tests.",
        "---",
        "",
        "Use this skill when user asks for snake game implementation.",
      ].join("\n"),
      [{ relativePath: "references/checklist.md", content: "# Checklist\n- game loop\n- keyboard\n" }],
    );

    const catalog = await discoverSkills({ cwd });
    assert.equal(catalog.skills.length, 1);
    assert.equal(catalog.skills[0]?.id, "snake-game");
    assert.equal(catalog.skills[0]?.description.includes("snake game"), true);
    assert.equal(catalog.skills[0]?.files.some((f) => f.path === "references/checklist.md"), true);
  });
});

test("searchSkills returns relevant skills ordered by query relevance", async () => {
  const cwd = await mkTmpDir("openoxen-skills-search");
  const home = path.join(cwd, ".home-openoxen");
  await withOpenOxenHome(home, async () => {
    await writeSkill(
      home,
      "typescript-refactor",
      [
        "---",
        "name: typescript-refactor",
        "description: Refactor TypeScript code with strict typing.",
        "---",
        "",
        "Use for TypeScript refactor requests.",
      ].join("\n"),
    );
    await writeSkill(
      home,
      "python-data",
      [
        "---",
        "name: python-data",
        "description: Build data pipelines in Python.",
        "---",
        "",
        "Use for Python ETL tasks.",
      ].join("\n"),
    );
    const catalog = await discoverSkills({ cwd });
    const hits = searchSkills(catalog, "typescript", 5);
    assert.equal(hits.length >= 1, true);
    assert.equal(hits[0]?.id, "typescript-refactor");
  });
});

test("OpenAI profile exposes search_skills/get_skill and session can execute them", async () => {
  const cwd = await mkTmpDir("openoxen-skills-tools");
  const home = path.join(cwd, ".home-openoxen");
  await withOpenOxenHome(home, async () => {
    await writeSkill(
      home,
      "snake-game",
      [
        "---",
        "name: snake-game",
        "description: Build a browser snake game with tests.",
        "---",
        "",
        "Steps:\n1. Write tests\n2. Implement game loop",
      ].join("\n"),
      [{ relativePath: "references/rules.md", content: "No wall wrap\n" }],
    );

    const env = new LocalExecutionEnvironment({ workingDir: cwd });
    const profile = createOpenAIProfile();
    const names = new Set(profile.toolRegistry.names());
    assert.equal(names.has("search_skills"), true);
    assert.equal(names.has("get_skill"), true);

    const client = new FakeClient([
      {
        text: "",
        tool_calls: [{ id: "1", name: "search_skills", arguments: { query: "snake", limit: 3 } }],
      },
      {
        text: "",
        tool_calls: [{ id: "2", name: "get_skill", arguments: { id: "snake-game" } }],
      },
      {
        text: "done",
        tool_calls: [],
      },
    ]);

    const session = new Session({ providerProfile: profile, executionEnv: env, llmClient: client });
    const result = await session.submit("实现一个网页版贪吃蛇");
    assert.equal(result.text, "done");

    const toolTurns = session.history().filter((turn) => turn.kind === "tool_results");
    assert.equal(toolTurns.length, 2);
    assert.equal(toolTurns[0]?.results[0]?.content.includes("snake-game"), true);
    assert.equal(toolTurns[1]?.results[0]?.content.includes("SKILL.md"), true);
  });
});
