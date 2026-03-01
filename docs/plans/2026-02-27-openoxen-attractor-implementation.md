# OpenOxen Attractor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build OpenOxen to implement Attractor + Coding Agent Loop specs, while using pi-ai instead of implementing the Unified LLM Client spec.

**Architecture:** OpenOxen has three layers: Attractor engine (`src/attractor`), Coding Agent Loop (`src/agent`), and pi-ai adapter (`src/llm-client`). The Attractor codergen handler uses a backend interface implemented by the pi-ai adapter. Tests are organized by spec section and include smoke-path integration coverage.

**Tech Stack:** TypeScript (Node 22 native type stripping), node:test, no runtime framework dependency.

### Task 1: Bootstrap project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `README.md`

**Step 1: Create baseline project files**

```bash
mkdir -p src/attractor src/agent src/llm-client tests docs/plans
```

**Step 2: Run test command to confirm baseline**

Run: `npm test`
Expected: command executes and reports no tests or missing test files.

### Task 2: Attractor parser + validator + conditions

**Files:**
- Create: `tests/attractor-core.test.ts`
- Create: `src/attractor/model.ts`
- Create: `src/attractor/parser.ts`
- Create: `src/attractor/validator.ts`
- Create: `src/attractor/condition.ts`

**Step 1: Write failing tests**
- Parse DOT subset, defaults, chained edges, subgraph flattening.
- Validate start/exit/reachability and condition syntax.

**Step 2: Run tests and verify failure**
Run: `npm test -- tests/attractor-core.test.ts`
Expected: FAIL due missing modules/exports.

**Step 3: Implement minimal parser/validator/condition evaluator**

**Step 4: Run tests and verify pass**
Run: `npm test -- tests/attractor-core.test.ts`
Expected: PASS.

### Task 3: Attractor runtime + handlers + checkpoint

**Files:**
- Create: `tests/attractor-engine.test.ts`
- Create: `src/attractor/context.ts`
- Create: `src/attractor/handlers.ts`
- Create: `src/attractor/interviewer.ts`
- Create: `src/attractor/styles.ts`
- Create: `src/attractor/engine.ts`
- Create: `src/attractor/index.ts`

**Step 1: Write failing runtime tests**
- Edge selection priority.
- Retry policy and goal gate enforcement.
- Wait.human routing.
- Checkpoint save/resume.

**Step 2: Run tests and verify failure**
Run: `npm test -- tests/attractor-engine.test.ts`
Expected: FAIL due unimplemented runtime.

**Step 3: Implement minimal runtime and handlers**

**Step 4: Run tests and verify pass**
Run: `npm test -- tests/attractor-engine.test.ts`
Expected: PASS.

### Task 4: Agent core

**Files:**
- Create: `tests/agent.test.ts`
- Create: `src/agent/types.ts`
- Create: `src/agent/truncation.ts`
- Create: `src/agent/tool-registry.ts`
- Create: `src/agent/execution-environment.ts`
- Create: `src/agent/providers.ts`
- Create: `src/agent/session.ts`
- Create: `src/agent/index.ts`

**Step 1: Write failing tests**
- Core loop natural completion.
- Unknown tool recovery.
- Truncation order.
- Steering/follow_up injection.
- Loop detection warning.

**Step 2: Run tests and verify failure**
Run: `npm test -- tests/agent.test.ts`
Expected: FAIL due missing implementation.

**Step 3: Implement session, providers, tools, environment**

**Step 4: Run tests and verify pass**
Run: `npm test -- tests/agent.test.ts`
Expected: PASS.

### Task 5: llm-client (pi-ai implementation) + integration smoke

**Files:**
- Create: `tests/integration-smoke.test.ts`
- Create: `src/llm-client/pi-ai.ts`

**Step 1: Write failing integration tests**
- Attractor codergen flow with injected pi-ai client.
- Coding loop LLM call flow using adapter response shape.

**Step 2: Run tests and verify failure**
Run: `npm test -- tests/integration-smoke.test.ts`
Expected: FAIL due adapter missing.

**Step 3: Implement adapter with extensible response mapping**

**Step 4: Run full suite**
Run: `npm test`
Expected: PASS.
