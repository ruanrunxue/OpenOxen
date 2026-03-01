import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { parseDot } from '../src/attractor/parser.ts';
import { runPipeline, createDefaultRuntime } from '../src/attractor/engine.ts';
import { QueueInterviewer } from '../src/attractor/interviewer.ts';

async function mkLogsRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

test('runPipeline executes linear pipeline and writes stage artifacts', async () => {
  const dot = `
  digraph test_pipeline {
    graph [goal="Create hello world"]
    start [shape=Mdiamond]
    plan [shape=box, prompt="Plan for: $goal"]
    done [shape=Msquare]
    start -> plan -> done
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-linear');
  const runtime = createDefaultRuntime();

  const result = await runPipeline(graph, { logsRoot, runtime });

  assert.equal(result.status, 'success');
  assert.equal(result.completedNodes.includes('plan'), true);

  const promptPath = path.join(logsRoot, 'plan', 'prompt.md');
  const responsePath = path.join(logsRoot, 'plan', 'response.md');
  const statusPath = path.join(logsRoot, 'plan', 'status.json');

  assert.equal(Boolean(await fs.stat(promptPath)), true);
  assert.equal(Boolean(await fs.stat(responsePath)), true);
  assert.equal(Boolean(await fs.stat(statusPath)), true);
});

test('goal gate unsatisfied reroutes to retry_target before exit', async () => {
  const dot = `
  digraph retry_gate {
    graph [retry_target="fix"]
    start [shape=Mdiamond]
    implement [shape=box, goal_gate=true, prompt="implement"]
    fix [shape=box, prompt="fix"]
    done [shape=Msquare]

    start -> implement
    implement -> done [condition="outcome=fail"]
    implement -> done [condition="outcome=success"]
    fix -> implement
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-goalgate');
  let implementAttempts = 0;
  const runtime = createDefaultRuntime({
    codergenBackend: {
      async run(node) {
        if (node.id === 'implement') {
          implementAttempts += 1;
          if (implementAttempts >= 2) {
            return { status: 'success' };
          }
          return { status: 'fail', failure_reason: 'not yet' };
        }
        return `ok:${node.id}`;
      },
    },
  });

  const result = await runPipeline(graph, { logsRoot, runtime });

  assert.equal(result.completedNodes.includes('fix'), true);
  assert.equal(result.status, 'success');
});

test('wait.human uses interviewer answer to route', async () => {
  const dot = `
  digraph human_gate {
    start [shape=Mdiamond]
    gate [shape=hexagon, label="Choose"]
    yes_path [shape=box, prompt="yes"]
    no_path [shape=box, prompt="no"]
    done [shape=Msquare]

    start -> gate
    gate -> yes_path [label="[Y] Yes"]
    gate -> no_path [label="[N] No"]
    yes_path -> done
    no_path -> done
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-human');
  const runtime = createDefaultRuntime({
    interviewer: new QueueInterviewer([{ value: 'Y' }]),
  });

  const result = await runPipeline(graph, { logsRoot, runtime });
  assert.equal(result.completedNodes.includes('yes_path'), true);
  assert.equal(result.completedNodes.includes('no_path'), false);
});

test('retry logic retries RETRY outcomes up to max_retries', async () => {
  const dot = `
  digraph retry {
    start [shape=Mdiamond]
    flaky [shape=box, max_retries=2, prompt="flaky"]
    done [shape=Msquare]
    start -> flaky -> done
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-retry');
  let attempts = 0;
  const runtime = createDefaultRuntime({
    codergenBackend: {
      async run() {
        attempts += 1;
        if (attempts < 3) {
          return { status: 'retry', failure_reason: 'transient' };
        }
        return { status: 'success' };
      },
    },
  });

  const result = await runPipeline(graph, { logsRoot, runtime });

  assert.equal(attempts, 3);
  assert.equal(result.status, 'success');
});

test('write_tests can set test.command and test node uses it via $test_command', async () => {
  const dot = `
  digraph dynamic_test_command {
    graph [goal="demo", default_test_command="node -e \\"process.exit(1)\\""]
    start [shape=Mdiamond]
    write_tests [shape=box, prompt="write tests"]
    test_1 [shape=parallelogram, tool_command="$test_command"]
    done [shape=Msquare]

    start -> write_tests -> test_1
    test_1 -> done [condition="outcome=success"]
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-dynamic-test-command');
  const runtime = createDefaultRuntime({
    codergenBackend: {
      async run(node) {
        if (node.id === 'write_tests') {
          return 'Planned tests\nTEST_COMMAND: node -e "process.exit(0)"';
        }
        return 'ok';
      },
    },
  });

  const result = await runPipeline(graph, { logsRoot, runtime });

  assert.equal(result.status, 'success');
  assert.equal(result.completedNodes.includes('test_1'), true);
  const testStatusRaw = await fs.readFile(path.join(logsRoot, 'test_1', 'status.json'), 'utf8');
  const testStatus = JSON.parse(testStatusRaw) as { status: string };
  assert.equal(testStatus.status, 'success');
});

test('unresolved $test_command placeholder should fail tool stage explicitly', async () => {
  const dot = `
  digraph unresolved_test_command {
    start [shape=Mdiamond]
    test_1 [shape=parallelogram, tool_command="$test_command"]
    done [shape=Msquare]
    start -> test_1
    test_1 -> done [condition="outcome=success"]
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-unresolved-test-command');
  const runtime = createDefaultRuntime();

  const result = await runPipeline(graph, { logsRoot, runtime });
  assert.equal(result.status, 'fail');

  const testStatusRaw = await fs.readFile(path.join(logsRoot, 'test_1', 'status.json'), 'utf8');
  const testStatus = JSON.parse(testStatusRaw) as { status: string; failure_reason?: string };
  assert.equal(testStatus.status, 'fail');
  assert.equal(String(testStatus.failure_reason ?? '').toLowerCase().includes('test_command'), true);
});

test('pipeline fails when node has only conditional edges and none match', async () => {
  const dot = `
  digraph no_condition_match {
    start [shape=Mdiamond]
    test_1 [shape=parallelogram, tool_command="node -e \\"process.exit(1)\\""]
    done [shape=Msquare]
    start -> test_1
    test_1 -> done [condition="outcome=success"]
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-no-condition-match');
  const runtime = createDefaultRuntime();
  const result = await runPipeline(graph, { logsRoot, runtime });

  assert.equal(result.status, 'fail');
  assert.equal(result.completedNodes.includes('done'), false);
});

test('failed test output is injected into next develop prompt via context variables', async () => {
  const dot = `
  digraph test_feedback_context {
    start [shape=Mdiamond]
    test_1 [shape=parallelogram, tool_command="node -e \\"process.stderr.write('E2E_FAIL'); process.exit(1)\\""]
    develop_1 [shape=box, prompt="Fix using latest signal: $test.last_failure"]
    done [shape=Msquare]
    start -> test_1
    test_1 -> develop_1 [condition="outcome=fail"]
    develop_1 -> done
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-test-feedback-context');
  let capturedPrompt = '';
  const runtime = createDefaultRuntime({
    codergenBackend: {
      async run(_node, prompt) {
        capturedPrompt = prompt;
        return 'applied fix';
      },
    },
  });

  const result = await runPipeline(graph, { logsRoot, runtime });
  assert.equal(result.status, 'success');
  assert.equal(capturedPrompt.includes('E2E_FAIL'), true);
});

test('variable expansion handles dotted context keys followed by punctuation', async () => {
  const dot = `
  digraph dotted_context_keys {
    start [shape=Mdiamond]
    write_tests [shape=box, prompt="write tests"]
    develop_1 [shape=box, prompt="Test command: $test.command. Continue."]
    done [shape=Msquare]
    start -> write_tests -> develop_1 -> done
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-dotted-context-keys');
  let capturedPrompt = '';
  const runtime = createDefaultRuntime({
    codergenBackend: {
      async run(node, prompt) {
        if (node.id === 'write_tests') {
          return 'TEST_COMMAND: npm test';
        }
        capturedPrompt = prompt;
        return 'ok';
      },
    },
  });

  const result = await runPipeline(graph, { logsRoot, runtime });
  assert.equal(result.status, 'success');
  assert.equal(capturedPrompt.includes('Test command: npm test. Continue.'), true);
});

test('test node treats fatal module-load stderr as failure even with zero exit code', async () => {
  const dot = `
  digraph test_fatal_stderr {
    graph [auto_test_repair=false]
    start [shape=Mdiamond]
    test_1 [shape=parallelogram, tool_command="node -e \\"console.error('Error: Cannot find module \\\\\\\"@playwright/test\\\\\\\"'); process.exit(0)\\""]
    done [shape=Msquare]
    start -> test_1
    test_1 -> done [condition="outcome=success"]
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-fatal-stderr');
  const runtime = createDefaultRuntime();
  const result = await runPipeline(graph, { logsRoot, runtime });

  assert.equal(result.status, 'fail');
  const testStatusRaw = await fs.readFile(path.join(logsRoot, 'test_1', 'status.json'), 'utf8');
  const testStatus = JSON.parse(testStatusRaw) as { status: string; failure_reason?: string };
  assert.equal(testStatus.status, 'fail');
  assert.equal(String(testStatus.failure_reason ?? '').toLowerCase().includes('cannot find module'), true);
});

test('test node treats failed summary in stdout as failure even with zero exit code', async () => {
  const dot = `
  digraph test_failed_summary_stdout {
    graph [auto_test_repair=false]
    start [shape=Mdiamond]
    test_1 [shape=parallelogram, tool_command="node -e \\"console.log('Running tests'); console.log('5 failed'); process.exit(0)\\""]
    done [shape=Msquare]
    start -> test_1
    test_1 -> done [condition="outcome=success"]
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-failed-summary-stdout');
  const runtime = createDefaultRuntime();
  const result = await runPipeline(graph, { logsRoot, runtime });

  assert.equal(result.status, 'fail');
  const testStatusRaw = await fs.readFile(path.join(logsRoot, 'test_1', 'status.json'), 'utf8');
  const testStatus = JSON.parse(testStatusRaw) as { status: string; failure_reason?: string };
  assert.equal(testStatus.status, 'fail');
  assert.equal(String(testStatus.failure_reason ?? '').toLowerCase().includes('failed'), true);
});

test('test node can auto-repair missing browser executable and rerun test', async () => {
  const marker = path.join(os.tmpdir(), `openoxen-browser-marker-${randomUUID()}`);
  const escapedMarker = marker.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const dot = `
  digraph test_auto_repair_browser {
    graph [auto_test_repair=true, auto_test_repair_max_attempts=2, repair_missing_browser_command="node -e \\"require('node:fs').writeFileSync('${escapedMarker}', 'ok')\\""]
    start [shape=Mdiamond]
    test_1 [shape=parallelogram, tool_command="node -e \\"const fs=require('node:fs'); const p='${escapedMarker}'; if(!fs.existsSync(p)){console.error('Error: browserType.launch: Executable doesn\\\\'t exist'); process.exit(1);} console.log('all good'); process.exit(0)\\""]
    done [shape=Msquare]
    start -> test_1
    test_1 -> done [condition="outcome=success"]
  }
  `;

  const graph = parseDot(dot);
  const logsRoot = await mkLogsRoot('openoxen-auto-repair-browser');
  const runtime = createDefaultRuntime();
  const result = await runPipeline(graph, { logsRoot, runtime });

  assert.equal(result.status, 'success');
  const testStatusRaw = await fs.readFile(path.join(logsRoot, 'test_1', 'status.json'), 'utf8');
  const testStatus = JSON.parse(testStatusRaw) as { status: string; notes?: string };
  assert.equal(testStatus.status, 'success');
  assert.equal(String(testStatus.notes ?? '').toLowerCase().includes('auto-repair'), true);
  await fs.rm(marker, { force: true });
});
