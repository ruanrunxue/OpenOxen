import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

test("package.json declares @mariozechner/pi-ai dependency", async () => {
  const pkgPath = path.join(root, "package.json");
  const raw = await fs.readFile(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string> };
  assert.equal(typeof pkg.dependencies?.["@mariozechner/pi-ai"], "string");
});

test("llm-client directly imports @mariozechner/pi-ai", async () => {
  const sourcePath = path.join(root, "src", "llm-client", "pi-ai.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  assert.match(source, /import\("@mariozechner\/pi-ai"\)/);
  assert.equal(source.includes("OPENOXEN_PI_MODULE"), false);
});
