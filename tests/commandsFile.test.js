import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';

import {
  consumeCommandsFile,
  createCommandsFileProcessor,
  isAllowedTransition,
} from '../src/engine/commands-file.js';

async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-commands-file-'));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeCommands(filePath, commands) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, commands.map((command) => JSON.stringify(command)).join('\n') + '\n');
}

function silentLogger() {
  return { info() {}, warn() {} };
}

test('isAllowedTransition: 許可遷移だけを accept する', () => {
  const allowed = [
    ['awaiting-approval', 'ready'],
    ['ready', 'awaiting-approval'],
    ['waiting-merge', 'done'],
    ['failed', 'ready'],
    ['ready', 'failed'],
  ];

  for (const [from, to] of allowed) {
    assert.equal(isAllowedTransition(from, to), true, `${from} -> ${to}`);
  }

  assert.equal(isAllowedTransition('in-progress', 'done'), false);
  assert.equal(isAllowedTransition('awaiting-approval', 'done'), false);
  assert.equal(isAllowedTransition('status:ready', 'status:done'), false);
});

test('consumeCommandsFile: CAS 一致なら setStatus を呼ぶ', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'cmd-1',
      taskId: '42',
      action: 'set-status',
      expected: 'status:awaiting-approval',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      now: () => new Date('2026-07-18T00:00:01.000Z'),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:awaiting-approval' }, { name: 'priority:high' }],
      }),
    });

    assert.deepEqual(calls, [[42, 'status:ready']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: CAS 不一致なら適用せず throw しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'cmd-2',
      taskId: 43,
      action: 'set-status',
      expected: 'awaiting-approval',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:failed' }],
      }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: 許可外遷移は拒否して setStatus を呼ばない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'cmd-3',
      taskId: 44,
      action: 'set-status',
      expected: 'in-progress',
      to: 'done',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => {
        throw new Error('CAS should not run for disallowed transitions');
      },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('createCommandsFileProcessor: 同じ id は同一実行内でも再起動相当でも二重適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [
      {
        id: 'cmd-4',
        taskId: '45',
        action: 'set-status',
        expected: 'failed',
        to: 'ready',
        requestedAt: '2026-07-18T00:00:00.000Z',
      },
      {
        id: 'cmd-4',
        taskId: '45',
        action: 'set-status',
        expected: 'failed',
        to: 'ready',
        requestedAt: '2026-07-18T00:00:00.000Z',
      },
    ]);

    const calls = [];
    const common = {
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:failed' }],
      }),
    };

    await createCommandsFileProcessor(common).consumeOnce();
    await createCommandsFileProcessor(common).consumeOnce();

    assert.deepEqual(calls, [[45, 'status:ready']]);
  });
});
