import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureOpenOxenLayout, getOpenOxenPaths, resolvePipelineLogsRoot } from "../src/openoxen/paths.ts";

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function withOpenOxenHome<T>(openoxenHome: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENOXEN_HOME;
  process.env.OPENOXEN_HOME = openoxenHome;
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

test("getOpenOxenPaths resolves all state under OPENOXEN_HOME", async () => {
  const tmp = await mkTmpDir("openoxen-paths-home");
  const home = path.join(tmp, ".openoxen-custom");
  await withOpenOxenHome(home, async () => {
    const paths = getOpenOxenPaths();
    assert.equal(paths.home, home);
    assert.equal(paths.configDir, path.join(home, "config"));
    assert.equal(paths.memoryDir, path.join(home, "memory"));
    assert.equal(paths.skillsDir, path.join(home, "skills"));
    assert.equal(paths.logsDir, path.join(home, "logs"));
    assert.equal(paths.authFile, path.join(home, "config", "auth.json"));
  });
});

test("ensureOpenOxenLayout creates expected directories", async () => {
  const tmp = await mkTmpDir("openoxen-paths-layout");
  const home = path.join(tmp, ".openoxen-custom");
  await withOpenOxenHome(home, async () => {
    const layout = await ensureOpenOxenLayout();
    const required = [layout.home, layout.configDir, layout.memoryDir, layout.skillsDir, layout.logsDir, layout.cacheDir, layout.tmpDir];
    for (const dir of required) {
      const stat = await fs.stat(dir);
      assert.equal(stat.isDirectory(), true);
    }
  });
});

test("resolvePipelineLogsRoot stores logs under ~/.openoxen/logs with project scope", async () => {
  const tmp = await mkTmpDir("openoxen-paths-logs");
  const home = path.join(tmp, ".openoxen-custom");
  await withOpenOxenHome(home, async () => {
    const cwd = path.join(tmp, "workspace", "OpenOxenDemo");
    const logsRoot = resolvePipelineLogsRoot(cwd, "pipeline.20260301-120000");
    assert.equal(logsRoot.startsWith(path.join(home, "logs")), true);
    assert.equal(logsRoot.endsWith(path.join("", "pipeline.20260301-120000")), true);
  });
});

