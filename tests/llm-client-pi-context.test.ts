import test from "node:test";
import assert from "node:assert/strict";

import { buildPiContext } from "../src/llm-client/pi-ai.ts";

test("buildPiContext preserves assistant tool calls and tool result linkage", () => {
  const context = buildPiContext({
    model: "gpt-5.2-codex",
    provider: "openai",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "do work" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", name: "write_file", arguments: { file_path: "a.txt", content: "A" } }],
      },
      { role: "tool", content: "ok", tool_call_id: "call-1", is_error: false },
    ],
    tools: [],
    tool_choice: "auto",
    reasoning_effort: null,
    provider_options: null,
  });

  const messages = (context as { messages: Array<Record<string, unknown>> }).messages;
  const assistant = messages.find((m) => m.role === "assistant");
  assert.equal(Boolean(assistant), true);
  const assistantContent = Array.isArray(assistant?.content) ? assistant.content : [];
  const assistantTool = assistantContent.find((b) => (b as { type?: string }).type === "toolCall") as
    | Record<string, unknown>
    | undefined;
  assert.equal(assistantTool?.name, "write_file");
  assert.equal(assistantTool?.id, "call-1");

  const toolResult = messages.find((m) => m.role === "toolResult");
  assert.equal(Boolean(toolResult), true);
  assert.equal(toolResult?.toolCallId, "call-1");
  assert.equal(toolResult?.toolName, "write_file");
  assert.equal(toolResult?.isError, false);
});
