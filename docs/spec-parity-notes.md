# OpenOxen Spec Parity Notes (2026-02-27)

This file tracks implemented scope against the upstream specs:
- `attractor-spec.md`
- `coding-agent-loop-spec.md`
- `unified-llm-spec.md` (intentionally not implemented; replaced by `llm-client` module with `pi-ai` implementation)

## Attractor

Implemented in `src/attractor/`:
- DOT parsing for digraph/node/edge statements, chained edges, defaults, subgraph flattening, comments, quoted/unquoted values.
- Validation for start/exit structure, reachability, edge target existence, and condition syntax.
- Condition expression evaluator for `=` / `!=` and `&&`.
- Execution engine traversal, deterministic edge selection, retry logic, goal gate checks, context updates, checkpoint writing.
- Built-in handlers: start, exit, codergen, wait.human, conditional, parallel (placeholder behavior), fan-in (basic), tool, manager loop (no-op).
- Stylesheet parser and application with selector specificity.

Partial / intentionally simplified:
- Parallel/fan-in behavior is minimal and not a full branch-subgraph scheduler.
- HTTP server mode and SSE event endpoints are not implemented.
- Artifact store API is not exposed as a dedicated public module.
- Full stack.manager_loop behavior is reduced to a no-op default handler.

## Coding Agent Loop

Implemented in `src/agent/`:
- Session lifecycle and core agent loop (`LLM call -> tool execution -> repeat until natural completion`).
- Provider profiles (OpenAI/Anthropic/Gemini) with provider-specific base prompt + tool registry.
- Shared core tools: read/write/edit/shell/grep/glob.
- OpenAI profile includes `apply_patch` (minimal implementation) and subagent tools.
- LocalExecutionEnvironment with command timeout + SIGTERM/SIGKILL handling and env-var filtering.
- Tool output truncation (character first, line second) and warnings.
- Steering queue, follow-up queue, loop detection, event emission.
- Subagent APIs (`spawn_agent`, `send_input`, `wait`, `close_agent`) with depth limiting.

Partial / intentionally simplified:
- `apply_patch` implementation covers basic add-file flow and validation only (not full v4a semantics).
- No real provider-native SDK prompt parity byte-for-byte.
- No streaming token/tool delta events yet.
- Context-window tracking warning is not yet implemented.

## LLM Client replacement

Implemented in `src/llm-client/pi-ai.ts`:
- `createPiAiClientAdapter`: adapts a pi-ai style client into OpenOxen `LLMClient`.
- `createPiAiCodergenBackend`: uses Agent Session + pi-ai implementation for Attractor codergen.

Note:
- `llm-client` is now the package boundary; `pi-ai` is one implementation and supports multiple method shapes (`complete`, `responses.create`, `generate`).

## Verification

- Full test suite: `npm test`
- Latest result: 16 tests passed, 0 failed.
