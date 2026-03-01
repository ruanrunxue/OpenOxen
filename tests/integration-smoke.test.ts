import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseDot, runPipeline, createDefaultRuntime } from '../src/attractor/index.ts';
import { LocalExecutionEnvironment, createOpenAIProfile, Session } from '../src/agent/index.ts';
import { createPiAiClientAdapter, createPiAiCodergenBackend } from '../src/llm-client/pi-ai.ts';

class FakePiClient {
  requests = [];

  async complete(request) {
    this.requests.push(request);
    const last = request.messages[request.messages.length - 1];
    return {
      id: 'fake-response',
      text: `PI:${last?.content ?? ''}`,
      tool_calls: [],
    };
  }
}

async function mkTmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

test('pi-ai implementation works with Agent session', async () => {
  const env = new LocalExecutionEnvironment({ workingDir: await mkTmpDir('openoxen-pi-loop') });
  const profile = createOpenAIProfile();
  const fake = new FakePiClient();
  const llmClient = createPiAiClientAdapter(fake);
  const session = new Session({ providerProfile: profile, executionEnv: env, llmClient });

  const result = await session.submit('create hello world file');

  assert.equal(result.text.startsWith('PI:'), true);
  assert.equal(Array.isArray(fake.requests[0]?.tools), true);
  assert.equal(fake.requests[0].tools.length > 0, true);
});

test('Attractor codergen backend routes through agent before llm-client/pi-ai', async () => {
  const dot = `
  digraph t {
    graph [goal="demo"]
    start [shape=Mdiamond]
    plan [shape=box, prompt="Plan for $goal"]
    done [shape=Msquare]
    start -> plan -> done
  }
  `;

  const logsRoot = await mkTmpDir('openoxen-pi-attractor');
  const fake = new FakePiClient();
  const llmClient = createPiAiClientAdapter(fake);
  const runtime = createDefaultRuntime({
    codergenBackend: createPiAiCodergenBackend(llmClient, { model: 'gpt-5.2-codex', provider: 'openai' }),
  });

  const result = await runPipeline(parseDot(dot), { logsRoot, runtime });
  assert.equal(result.status, 'success');

  const response = await fs.readFile(path.join(logsRoot, 'plan', 'response.md'), 'utf8');
  assert.equal(response.startsWith('PI:'), true);
  assert.equal(Array.isArray(fake.requests[0]?.tools), true);
  assert.equal(fake.requests[0].tools.length > 0, true);
});
