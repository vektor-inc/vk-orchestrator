import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function makeTempDir() {
  return fs.mkdtemp(join(tmpdir(), 'vk-orchestrator-lock-'));
}

describe('start lock', () => {
  it('生存中 PID のロックがある場合は起動を中止するエラーにする', async () => {
    const { createStartLock } = await import('../src/engine/start-lock.js');
    const dir = await makeTempDir();
    const lockFile = join(dir, 'orchestrator.lock');
    await fs.writeFile(lockFile, JSON.stringify({ pid: 111, startedAt: '2026-07-10T00:00:00.000Z' }), 'utf8');

    const lock = createStartLock({
      lockFile,
      process: {
        pid: 222,
        kill(pid, signal) {
          assert.equal(pid, 111);
          assert.equal(signal, 0);
          return true;
        },
      },
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    });

    await assert.rejects(() => lock.acquire(), /既に起動中.*pid=111/);
    assert.equal(
      await fs.readFile(lockFile, 'utf8'),
      JSON.stringify({ pid: 111, startedAt: '2026-07-10T00:00:00.000Z' }),
      '生存中ロックは上書きしない'
    );
  });

  it('stale lock は奪取して release で削除する', async () => {
    const { createStartLock } = await import('../src/engine/start-lock.js');
    const dir = await makeTempDir();
    const lockFile = join(dir, 'orchestrator.lock');
    await fs.writeFile(lockFile, JSON.stringify({ pid: 111, startedAt: '2026-07-10T00:00:00.000Z' }), 'utf8');

    const lock = createStartLock({
      lockFile,
      process: {
        pid: 222,
        kill() {
          const err = new Error('not found');
          err.code = 'ESRCH';
          throw err;
        },
      },
      now: () => new Date('2026-07-10T01:00:00.000Z'),
    });

    const result = await lock.acquire();
    assert.deepEqual(result, { acquired: true, stale: true, previousPid: 111 });
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, 'utf8')), {
      pid: 222,
      startedAt: '2026-07-10T01:00:00.000Z',
    });

    await lock.release();
    await assert.rejects(() => fs.readFile(lockFile, 'utf8'), /ENOENT/);
  });
});
