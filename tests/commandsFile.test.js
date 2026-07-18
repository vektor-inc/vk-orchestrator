import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

function captureLogger() {
  const entries = { info: [], warn: [] };
  return {
    entries,
    logger: {
      info(message) { entries.info.push(message); },
      warn(message) { entries.warn.push(message); },
    },
  };
}

function httpError(status, message = `HTTP ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

test('isAllowedTransition: 許可遷移だけを accept する', () => {
  const allowed = [
    ['awaiting-approval', 'ready'],
    ['ready', 'awaiting-approval'],
    ['in-progress', 'awaiting-approval'],
    ['waiting-input', 'awaiting-approval'],
    ['waiting-merge', 'awaiting-approval'],
    ['failed', 'awaiting-approval'],
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

test('consumeCommandsFile: 差し戻し遷移は awaiting-approval へ戻せる', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'revert-to-approval',
      taskId: 41,
      action: 'set-status',
      expected: 'waiting-input',
      to: 'awaiting-approval',
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
        labels: [{ name: 'status:waiting-input' }],
      }),
    });

    assert.deepEqual(calls, [[41, 'status:awaiting-approval']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
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

test('consumeCommandsFile: set-priority は CAS 一致なら setPriority を呼ぶ', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'priority-apply',
      taskId: 50,
      action: 'set-priority',
      expected: 'medium',
      to: 'high',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }, { name: 'priority:medium' }],
      }),
    });

    assert.deepEqual(calls, [[50, 'high']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: set-priority は none を優先度ラベル無しとして扱う', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'priority-none',
      taskId: 51,
      action: 'set-priority',
      expected: 'none',
      to: 'low',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }],
      }),
    });

    assert.deepEqual(calls, [[51, 'low']]);
  });
});

test('consumeCommandsFile: set-priority は CAS 不一致なら適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'priority-cas-mismatch',
      taskId: 52,
      action: 'set-priority',
      expected: 'high',
      to: 'low',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'priority:medium' }],
      }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-priority は不正値を拒否してメタ issue を読まない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'priority-invalid',
      taskId: 53,
      action: 'set-priority',
      expected: 'high',
      to: 'urgent',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setPriority: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called for invalid priority');
      },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-sequential は CAS 一致なら setSequential を呼ぶ', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'sequential-apply',
      taskId: 54,
      action: 'set-sequential',
      expected: 'parallel',
      to: 'sequential',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setSequential: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:ready' }],
      }),
    });

    assert.deepEqual(calls, [[54, 'sequential']]);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 1, skipped: 0 });
  });
});

test('consumeCommandsFile: set-sequential は CAS 不一致なら適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'sequential-cas-mismatch',
      taskId: 55,
      action: 'set-sequential',
      expected: 'parallel',
      to: 'sequential',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setSequential: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'sequential' }],
      }),
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
  });
});

test('consumeCommandsFile: set-sequential は不正値を拒否してメタ issue を読まない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'sequential-invalid',
      taskId: 56,
      action: 'set-sequential',
      expected: 'parallel',
      to: 'serialized',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setSequential: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called for invalid sequential');
      },
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

test('consumeCommandsFile: 未対応 action は consumed 扱いで無視する', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'unsupported',
      taskId: 49,
      action: 'set-label',
      expected: 'old',
      to: 'new',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const summary = await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async () => {
          throw new Error('setStatus should not be called for unsupported action');
        },
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called for unsupported action');
      },
    });

    assert.deepEqual(summary, { read: 1, evaluated: 1, applied: 0, skipped: 0 });
    assert.equal(JSON.parse(readFileSync(processedPath, 'utf8')).consumedLines, 1);
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

test('consumeCommandsFile: 恒久失敗 4xx は隔離して 2 回目に再試行しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'poison-404',
      taskId: 404,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const { entries, logger } = captureLogger();
    let getCalls = 0;
    const setCalls = [];
    const common = {
      commandsPath,
      processedPath: statePath,
      logger,
      github: {
        setStatus: async (...args) => setCalls.push(args),
      },
      getMetaIssue: async () => {
        getCalls += 1;
        throw httpError(404, 'not found');
      },
    };

    await consumeCommandsFile(common);
    await consumeCommandsFile(common);

    assert.equal(getCalls, 1);
    assert.deepEqual(setCalls, []);
    assert.equal(entries.warn.length, 1);
    assert.match(entries.warn[0], /恒久失敗/);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).consumedLines, 1);
  });
});

test('consumeCommandsFile: 一時失敗 5xx は上限までリトライし超過後に隔離する', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'poison-500',
      taskId: 500,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const { logger } = captureLogger();
    let getCalls = 0;
    const common = {
      commandsPath,
      processedPath: statePath,
      logger,
      transientRetryLimit: 2,
      github: {
        setStatus: async () => {
          throw new Error('setStatus should not be called');
        },
      },
      getMetaIssue: async () => {
        getCalls += 1;
        throw httpError(500, 'server\nfailed');
      },
    };

    await consumeCommandsFile(common);
    await consumeCommandsFile(common);
    await consumeCommandsFile(common);
    await consumeCommandsFile(common);

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(getCalls, 3);
    assert.equal(state.consumedLines, 1);
    assert.equal(state.retry, null);
  });
});

test('consumeCommandsFile: 403 は一時失敗として上限超過までリトライする', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'secondary-rate-limit-403',
      taskId: 403,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const { entries, logger } = captureLogger();
    let getCalls = 0;
    const common = {
      commandsPath,
      processedPath: statePath,
      logger,
      transientRetryLimit: 2,
      github: {
        setStatus: async () => {
          throw new Error('setStatus should not be called');
        },
      },
      getMetaIssue: async () => {
        getCalls += 1;
        throw httpError(403, 'secondary rate limit');
      },
    };

    await consumeCommandsFile(common);

    const firstState = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(getCalls, 1);
    assert.equal(firstState.consumedLines, 0);
    assert.equal(firstState.retry?.lineNumber, 1);
    assert.equal(firstState.retry?.attempts, 1);
    assert.doesNotMatch(entries.warn[0], /恒久失敗/);

    await consumeCommandsFile(common);
    await consumeCommandsFile(common);
    await consumeCommandsFile(common);

    const finalState = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(getCalls, 3);
    assert.equal(finalState.consumedLines, 1);
    assert.equal(finalState.retry, null);
  });
});

test('consumeCommandsFile: 不良行は 2 回目に再 warn / 再評価しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    mkdirSync(dirname(commandsPath), { recursive: true });
    writeFileSync(
      commandsPath,
      '{"id":"bad-json",\n' +
        JSON.stringify({ id: 'missing-keys', taskId: 46 }) + '\n'
    );

    const { entries, logger } = captureLogger();
    let getCalls = 0;
    const common = {
      commandsPath,
      processedPath: statePath,
      logger,
      github: { setStatus: async () => {} },
      getMetaIssue: async () => {
        getCalls += 1;
        throw new Error('getMetaIssue should not be called');
      },
    };

    await consumeCommandsFile(common);
    await consumeCommandsFile(common);

    assert.equal(getCalls, 0);
    assert.equal(entries.warn.length, 2);
    assert.match(entries.warn[0], /JSON パースに失敗/);
    assert.match(entries.warn[1], /必須キーが不足/);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).consumedLines, 2);
  });
});

test('consumeCommandsFile: 永続状態を読み直す再起動相当でも確定済み行を再適用しない', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const processedPath = join(dir, 'commands-processed.json');
    writeCommands(commandsPath, [{
      id: 'restart-safe',
      taskId: 47,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    }]);

    const calls = [];
    await consumeCommandsFile({
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

    await consumeCommandsFile({
      commandsPath,
      processedPath,
      logger: silentLogger(),
      github: {
        setStatus: async () => {
          throw new Error('setStatus should not be called after restart');
        },
      },
      getMetaIssue: async () => {
        throw new Error('getMetaIssue should not be called after restart');
      },
    });

    assert.deepEqual(calls, [[47, 'status:ready']]);
  });
});

test('consumeCommandsFile: 行カーソルを進め、不完全な末尾行は次回へ残す', async () => {
  await withTmpDir(async (dir) => {
    const commandsPath = join(dir, 'commands.jsonl');
    const statePath = join(dir, 'commands-processed.json');
    const complete = {
      id: 'complete-line',
      taskId: 48,
      action: 'set-status',
      expected: 'failed',
      to: 'ready',
      requestedAt: '2026-07-18T00:00:00.000Z',
    };
    mkdirSync(dirname(commandsPath), { recursive: true });
    writeFileSync(commandsPath, JSON.stringify(complete) + '\n{"id":"incomplete"');

    const calls = [];
    await consumeCommandsFile({
      commandsPath,
      processedPath: statePath,
      logger: silentLogger(),
      github: {
        setStatus: async (...args) => calls.push(args),
      },
      getMetaIssue: async () => ({
        labels: [{ name: 'status:failed' }],
      }),
    });

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(calls, [[48, 'status:ready']]);
    assert.equal(state.consumedLines, 1);
    assert.equal(readFileSync(commandsPath, 'utf8'), JSON.stringify(complete) + '\n{"id":"incomplete"');
  });
});
