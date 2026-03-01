import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../src/cli/main.ts';

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

test('openoxen dev generates timestamped dot in cwd and immediately executes run', async () => {
  const cwd = await mkTmpDir('openoxen-cli-default');
  const logs: string[] = [];
  const errors: string[] = [];
  let ranDot: string | null = null;

  const exitCode = await runCli(['dev', '实现一个todo接口'], {
    cwd: () => cwd,
    now: () => new Date('2026-02-27T23:15:00Z'),
    log: (line) => logs.push(line),
    error: (line) => errors.push(line),
    createLlmClient: async () => ({ complete: async () => ({ text: 'ok', tool_calls: [] }) }),
    generateDot: async () => 'digraph p { start [shape=Mdiamond] done [shape=Msquare] start -> done }',
    runDot: async (dot) => {
      ranDot = dot;
      return { status: 'success', logsRoot: path.join(cwd, '.openoxen.logs.20260227-231500') };
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(ranDot !== null, true);

  const expectedFile = path.join(cwd, 'openoxen.pipeline.20260227-231500.dot');
  const saved = await fs.readFile(expectedFile, 'utf8');
  assert.equal(saved.includes('digraph p'), true);
  assert.equal(errors.length, 0);
  assert.equal(logs.some((l) => l.includes('Running Attractor')), true);
});

test('openoxen dev --task uses task name as dot filename', async () => {
  const cwd = await mkTmpDir('openoxen-cli-task');

  const exitCode = await runCli(['dev', '实现用户登录', '--task', 'user-login-pipeline'], {
    cwd: () => cwd,
    now: () => new Date('2026-02-27T23:20:00Z'),
    log: () => {},
    error: () => {},
    createLlmClient: async () => ({ complete: async () => ({ text: 'ok', tool_calls: [] }) }),
    generateDot: async () => 'digraph p { start [shape=Mdiamond] done [shape=Msquare] start -> done }',
    runDot: async () => ({ status: 'success', logsRoot: path.join(cwd, '.logs') }),
  });

  assert.equal(exitCode, 0);

  const expectedFile = path.join(cwd, 'user-login-pipeline.dot');
  const saved = await fs.readFile(expectedFile, 'utf8');
  assert.equal(saved.includes('digraph p'), true);
});

test('openoxen dev without requirement exits with usage error', async () => {
  const errors: string[] = [];
  const code = await runCli(['dev'], {
    cwd: () => process.cwd(),
    log: () => {},
    error: (line) => errors.push(line),
  });

  assert.equal(code, 1);
  assert.equal(errors.some((l) => l.includes('openoxen dev')), true);
});

test('openoxen dev --quiet disables verbose tracing context', async () => {
  const cwd = await mkTmpDir('openoxen-cli-quiet');
  let generateVerbose: boolean | null = null;
  let runVerbose: boolean | null = null;

  const code = await runCli(['dev', '实现一个todo接口', '--quiet'], {
    cwd: () => cwd,
    now: () => new Date('2026-02-27T23:30:00Z'),
    log: () => {},
    error: () => {},
    createLlmClient: async () => ({ complete: async () => ({ text: 'ok', tool_calls: [] }) }),
    generateDot: async (_req, params) => {
      generateVerbose = params.verbose;
      return 'digraph p { start [shape=Mdiamond] done [shape=Msquare] start -> done }';
    },
    runDot: async (_dot, params) => {
      runVerbose = params.verbose;
      return { status: 'success', logsRoot: path.join(cwd, '.logs') };
    },
  });

  assert.equal(code, 0);
  assert.equal(generateVerbose, false);
  assert.equal(runVerbose, false);
});

test('openoxen login triggers oauth flow for openai-codex by default', async () => {
  const logs: string[] = [];
  let providerSeen: string | null = null;

  const code = await runCli(['login'], {
    cwd: () => process.cwd(),
    log: (line) => logs.push(line),
    error: () => {},
    loginOauth: async (provider) => {
      providerSeen = provider;
      return { provider, status: 'ok' };
    },
  });

  assert.equal(code, 0);
  assert.equal(providerSeen, 'openai-codex');
  assert.equal(logs.some((l) => l.includes('OAuth login successful')), true);
});

test('openoxen login returns non-zero on oauth failure', async () => {
  const errors: string[] = [];

  const code = await runCli(['login'], {
    cwd: () => process.cwd(),
    log: () => {},
    error: (line) => errors.push(line),
    loginOauth: async () => {
      throw new Error('oauth failed');
    },
  });

  assert.equal(code, 1);
  assert.equal(errors.some((l) => l.includes('oauth failed')), true);
});

test('openoxen login --provider passes provider to oauth handler', async () => {
  let providerSeen: string | null = null;
  const code = await runCli(['login', '--provider', 'openai-codex'], {
    cwd: () => process.cwd(),
    log: () => {},
    error: () => {},
    loginOauth: async (provider) => {
      providerSeen = provider;
      return { provider, status: 'ok' };
    },
  });

  assert.equal(code, 0);
  assert.equal(providerSeen, 'openai-codex');
});
