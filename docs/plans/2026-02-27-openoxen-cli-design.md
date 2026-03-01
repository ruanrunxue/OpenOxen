# OpenOxen CLI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `openoxen dev "<需求>"` CLI that generates a DOT pipeline via Agent, saves DOT in current directory, and immediately runs Attractor.

**Architecture:** CLI layer (`src/cli`) orchestrates argument parsing, Agent-driven DOT generation, file persistence, and pipeline execution. The call chain is `CLI -> Agent Session -> llm-client/pi-ai` and `CLI -> Attractor Runtime`. Human intervention is handled by `wait.human` node after 5 failed test loops.

**Tech Stack:** Node.js 22, TypeScript, existing `src/agent`, `src/attractor`, `src/llm-client`, `node:test`.

### Task 1: CLI contract tests (RED)

**Files:**
- Create: `tests/cli.test.ts`

**Step 1: Write failing tests**
- `openoxen dev "需求"` creates timestamped DOT in cwd and executes pipeline.
- `--task name` uses user task name as filename.
- Missing requirement exits with usage error.

**Step 2: Run test to verify failure**
Run: `npm test -- tests/cli.test.ts`
Expected: FAIL due missing CLI module.

### Task 2: Implement CLI orchestration (GREEN)

**Files:**
- Create: `src/cli/dev.ts`
- Create: `src/cli/main.ts`
- Create: `bin/openoxen.js`
- Modify: `package.json`

**Step 1: Implement args parser and `dev` command**
- Parse `openoxen dev <requirement> [--task <name>]`.
- Build output DOT file path in cwd (timestamp default / task name override).

**Step 2: Implement agent-based DOT generation**
- Use `src/agent` `Session` + `src/llm-client/pi-ai` adapter to request DOT.
- Validate generated DOT with parser/validator; fallback to safe template if invalid.

**Step 3: Execute Attractor immediately**
- Create runtime with codergen backend via `createPiAiCodergenBackend`.
- Run pipeline and return process code by run result.

### Task 3: Verify and docs

**Files:**
- Modify: `README.md`

**Step 1: Run tests**
Run: `npm test -- tests/cli.test.ts`
Expected: PASS.

**Step 2: Run full suite**
Run: `npm test`
Expected: PASS.

**Step 3: Document CLI usage**
- Add `openoxen dev` usage and options in README.
