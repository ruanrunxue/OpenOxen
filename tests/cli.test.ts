import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCli } from '../src/cli/main.ts';

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

async function writeSkill(
  openoxenHome: string,
  id: string,
  content = "---\nname: snake-game\ndescription: Snake skill\n---\n\nUse this skill.\n",
): Promise<void> {
  const dir = path.join(openoxenHome, 'skills', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf8');
}

async function withOpenOxenHome<T>(openoxenHome: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENOXEN_HOME;
  process.env.OPENOXEN_HOME = openoxenHome;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env.OPENOXEN_HOME;
    } else {
      process.env.OPENOXEN_HOME = prev;
    }
  }
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

test('openoxen skills list prints discovered skills', async () => {
  const cwd = await mkTmpDir('openoxen-cli-skills-list');
  const logs: string[] = [];
  const home = path.join(cwd, '.home-openoxen');
  await withOpenOxenHome(home, async () => {
    await writeSkill(home, 'snake-game');

    const code = await runCli(['skills', 'list'], {
      cwd: () => cwd,
      log: (line) => logs.push(line),
      error: () => {},
    });

    assert.equal(code, 0);
    assert.equal(logs.some((line) => line.includes('snake-game')), true);
  });
});

test('openoxen skills get prints skill content', async () => {
  const cwd = await mkTmpDir('openoxen-cli-skills-get');
  const logs: string[] = [];
  const home = path.join(cwd, '.home-openoxen');
  await withOpenOxenHome(home, async () => {
    await writeSkill(
      home,
      'snake-game',
      [
        '---',
        'name: snake-game',
        'description: Build snake game',
        '---',
        '',
        'Write tests first.',
      ].join('\n'),
    );

    const code = await runCli(['skills', 'get', 'snake-game'], {
      cwd: () => cwd,
      log: (line) => logs.push(line),
      error: () => {},
    });

    assert.equal(code, 0);
    assert.equal(logs.some((line) => line.includes('Build snake game')), true);
    assert.equal(logs.some((line) => line.includes('Write tests first')), true);
  });
});

test('openoxen skills install with github url delegates to installer', async () => {
  const cwd = await mkTmpDir('openoxen-cli-skills-install-url');
  const logs: string[] = [];
  const home = path.join(cwd, '.home-openoxen');
  let captured: { url?: string; dest: string } | null = null;
  await withOpenOxenHome(home, async () => {
    const code = await runCli(['skills', 'install', 'https://github.com/openai/skills/tree/main/skills/.curated/doc'], {
      cwd: () => cwd,
      log: (line) => logs.push(line),
      error: () => {},
      installSkillFromSource: async (params) => {
        captured = { url: params.url, dest: params.dest };
        return { stdout: `Installed doc to ${params.dest}/doc` };
      },
    });

    assert.equal(code, 0);
    assert.equal(captured?.url?.includes('github.com/openai/skills'), true);
    assert.equal(captured?.dest, path.join(home, 'skills'));
    assert.equal(logs.some((line) => line.includes('Installed doc')), true);
  });
});

test('openoxen skills install by name resolves from remote skills list', async () => {
  const cwd = await mkTmpDir('openoxen-cli-skills-install-name');
  const logs: string[] = [];
  const home = path.join(cwd, '.home-openoxen');
  let captured: { repo?: string; skillPath?: string; dest: string } | null = null;
  await withOpenOxenHome(home, async () => {
    const code = await runCli(['skills', 'install', 'typescript'], {
      cwd: () => cwd,
      log: (line) => logs.push(line),
      error: () => {},
      listRemoteSkills: async () => [
        { name: 'typescript', repo: 'openai/skills', path: 'skills/.curated/typescript', ref: 'main' },
        { name: 'doc', repo: 'openai/skills', path: 'skills/.curated/doc', ref: 'main' },
      ],
      installSkillFromSource: async (params) => {
        captured = { repo: params.repo, skillPath: params.path, dest: params.dest };
        return { stdout: `Installed typescript to ${params.dest}/typescript` };
      },
    });

    assert.equal(code, 0);
    assert.equal(captured?.repo, 'openai/skills');
    assert.equal(captured?.skillPath, 'skills/.curated/typescript');
    assert.equal(captured?.dest, path.join(home, 'skills'));
    assert.equal(logs.some((line) => line.includes("Resolved skill 'typescript'")), true);
  });
});
