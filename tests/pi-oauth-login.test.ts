import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOauthAuthInfo } from "../src/llm-client/pi-ai.ts";

test("normalizeOauthAuthInfo handles object auth info from pi-ai", () => {
  const normalized = normalizeOauthAuthInfo({
    url: "https://auth.openai.com/authorize",
    instructions: "Paste code back to terminal",
  });

  assert.equal(normalized.url, "https://auth.openai.com/authorize");
  assert.equal(normalized.instructions, "Paste code back to terminal");
});

test("normalizeOauthAuthInfo remains backward compatible with string input", () => {
  const normalized = normalizeOauthAuthInfo("https://example.com/login");
  assert.equal(normalized.url, "https://example.com/login");
  assert.equal(normalized.instructions, undefined);
});
