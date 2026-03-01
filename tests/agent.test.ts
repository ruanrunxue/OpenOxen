import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalExecutionEnvironment } from '../src/agent/execution-environment.ts';
import { createOpenAIProfile } from '../src/agent/providers.ts';
import { Session } from '../src/agent/session.ts';
import { truncateToolOutput } from '../src/agent/truncation.ts';

class FakeClient {
  #responses;
  #index = 0;

  constructor(responses) {
    this.#responses = responses;
  }

  async complete() {
    const out = this.#responses[this.#index] ?? { text: 'done', tool_calls: [] };
    this.#index += 1;
    return out;
  }
}

class CapturingClient {
  #responses;
  #index = 0;
  requests = [];

  constructor(responses) {
    this.#responses = responses;
  }

  async complete(request) {
    this.requests.push(request);
    const out = this.#responses[this.#index] ?? { text: 'done', tool_calls: [] };
    this.#index += 1;
    return out;
  }
}

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

test('Session natural completion when model returns text-only response', async () => {
  const workingDir = await mkTmpDir('openoxen-loop-natural');
  const env = new LocalExecutionEnvironment({ workingDir });
  const profile = createOpenAIProfile();
  const client = new FakeClient([{ text: 'All done', tool_calls: [] }]);
  const session = new Session({ providerProfile: profile, executionEnv: env, llmClient: client });

  const result = await session.submit('say hi');

  assert.equal(result.text.includes('All done'), true);
  assert.equal(session.state(), 'IDLE');
});

test('Unknown tool call returns error ToolResult to model loop', async () => {
  const workingDir = await mkTmpDir('openoxen-loop-unknown-tool');
  const env = new LocalExecutionEnvironment({ workingDir });
  const profile = createOpenAIProfile();
  const client = new FakeClient([
    {
      text: '',
      tool_calls: [{ id: '1', name: 'does_not_exist', arguments: {} }],
    },
    {
      text: 'recovered',
      tool_calls: [],
    },
  ]);
  const session = new Session({ providerProfile: profile, executionEnv: env, llmClient: client });

  const result = await session.submit('test unknown tool');

  assert.equal(result.text, 'recovered');
  const toolTurns = session.history().filter((h) => h.kind === 'tool_results');
  assert.equal(toolTurns.length, 1);
  assert.equal(toolTurns[0].results[0].is_error, true);
});

test('Session preserves assistant tool_calls in next LLM request context', async () => {
  const workingDir = await mkTmpDir('openoxen-loop-tool-context');
  const env = new LocalExecutionEnvironment({ workingDir });
  const profile = createOpenAIProfile();
  const client = new CapturingClient([
    {
      text: '',
      tool_calls: [{ id: 'call-1', name: 'write_file', arguments: { file_path: 'a.txt', content: 'A' } }],
    },
    {
      text: 'done',
      tool_calls: [],
    },
  ]);
  const session = new Session({ providerProfile: profile, executionEnv: env, llmClient: client });

  const result = await session.submit('write file');
  assert.equal(result.text, 'done');
  assert.equal(client.requests.length, 2);

  const second = client.requests[1];
  const assistantMsg = second.messages.find((m) => m.role === 'assistant');
  assert.equal(Boolean(assistantMsg), true);
  assert.equal(Array.isArray(assistantMsg.tool_calls), true);
  assert.equal(assistantMsg.tool_calls[0]?.id, 'call-1');

  const toolMsg = second.messages.find((m) => m.role === 'tool');
  assert.equal(toolMsg?.tool_call_id, 'call-1');
});

test('LocalExecutionEnvironment read/write/shell workflow', async () => {
  const workingDir = await mkTmpDir('openoxen-loop-env');
  const env = new LocalExecutionEnvironment({ workingDir });

  await env.writeFile('hello.py', "print('Hello')\n");
  const text = await env.readFile('hello.py');
  assert.equal(text.includes('Hello'), true);

  const result = await env.execCommand('python3 hello.py', 10_000);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout.includes('Hello'), true);
});

test('truncateToolOutput applies char truncation before line truncation', () => {
  const veryLong = `${'x'.repeat(60_000)}\n${'y'.repeat(60_000)}`;
  const out = truncateToolOutput(veryLong, 'read_file', {
    tool_output_limits: { read_file: 50_000 },
    tool_line_limits: { read_file: 10 },
  });

  assert.equal(out.includes('[WARNING: Tool output was truncated.'), true);
  assert.equal(out.length < veryLong.length, true);
});

test('steer message is injected between tool rounds', async () => {
  const workingDir = await mkTmpDir('openoxen-loop-steer');
  const env = new LocalExecutionEnvironment({ workingDir });
  const profile = createOpenAIProfile();
  const client = new FakeClient([
    {
      text: '',
      tool_calls: [{ id: '1', name: 'write_file', arguments: { file_path: 'a.txt', content: 'A' } }],
    },
    {
      text: 'done',
      tool_calls: [],
    },
  ]);

  const session = new Session({ providerProfile: profile, executionEnv: env, llmClient: client });
  session.steer('Use minimal changes');
  await session.submit('write file');

  const steeringTurns = session.history().filter((h) => h.kind === 'steering');
  assert.equal(steeringTurns.length >= 1, true);
  assert.equal(steeringTurns[0].content.includes('minimal'), true);
});

test('loop detection emits warning on repeated tool pattern', async () => {
  const workingDir = await mkTmpDir('openoxen-loop-detect');
  const env = new LocalExecutionEnvironment({ workingDir });
  const profile = createOpenAIProfile();
  const responses = [];
  for (let i = 0; i < 10; i += 1) {
    responses.push({
      text: '',
      tool_calls: [{ id: `${i}`, name: 'glob', arguments: { pattern: '**/*.ts' } }],
    });
  }
  responses.push({ text: 'finish', tool_calls: [] });

  const client = new FakeClient(responses);
  const session = new Session({
    providerProfile: profile,
    executionEnv: env,
    llmClient: client,
    config: { loop_detection_window: 6 },
  });

  await session.submit('find ts files');

  const loopEvents = session.events().filter((e) => e.kind === 'LOOP_DETECTION');
  assert.equal(loopEvents.length >= 1, true);
});

test('OpenAI profile exposes common tool aliases (openclaw-style)', () => {
  const profile = createOpenAIProfile();
  const names = new Set(profile.toolRegistry.names());
  for (const name of ['read', 'write', 'edit', 'ls', 'find', 'search', 'exec', 'bash', 'process']) {
    assert.equal(names.has(name), true, `missing tool alias: ${name}`);
  }
});

test('Session can execute aliased write tool call', async () => {
  const workingDir = await mkTmpDir('openoxen-loop-alias-write');
  const env = new LocalExecutionEnvironment({ workingDir });
  const profile = createOpenAIProfile();
  const client = new FakeClient([
    {
      text: '',
      tool_calls: [{ id: '1', name: 'write', arguments: { path: 'snake.txt', content: 'hello snake' } }],
    },
    {
      text: 'done',
      tool_calls: [],
    },
  ]);
  const session = new Session({ providerProfile: profile, executionEnv: env, llmClient: client });

  const result = await session.submit('write a file');
  assert.equal(result.text, 'done');
  const content = await fs.readFile(path.join(workingDir, 'snake.txt'), 'utf8');
  assert.equal(content, 'hello snake');
});
