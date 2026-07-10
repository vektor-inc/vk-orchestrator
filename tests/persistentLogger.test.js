import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

async function makeTempDir() {
  return fs.mkdtemp(join(tmpdir(), 'vk-orchestrator-logger-'));
}

describe('persistent logger', () => {
  it('console 出力を維持しつつ、ISO 時刻付き・秘匿情報マスク済みの行をファイルへ追記する', async () => {
    const { createPersistentLogger } = await import('../src/engine/persistent-logger.js');
    const dir = await makeTempDir();
    const logFile = join(dir, 'orchestrator.log');
    const consoleCalls = [];

    const logger = createPersistentLogger({
      logFile,
      console: {
        log: (...args) => consoleCalls.push(['log', args]),
        warn: (...args) => consoleCalls.push(['warn', args]),
        error: (...args) => consoleCalls.push(['error', args]),
      },
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    logger.log('token', 'ghp_abcdefghijklmnopqrstuvwxyz123456');

    assert.deepEqual(consoleCalls, [['log', ['token', 'ghp_abcdefghijklmnopqrstuvwxyz123456']]]);
    const text = await fs.readFile(logFile, 'utf8');
    assert.match(text, /^\[2026-07-10T00:00:00\.000Z\] \[log\] token \*\*\*REDACTED\*\*\*$/m);
    assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  });

  it('最大サイズを超えた既存ログを .1 へ退避してから新しい行を書き込む', async () => {
    const { createPersistentLogger } = await import('../src/engine/persistent-logger.js');
    const dir = await makeTempDir();
    const logFile = join(dir, 'orchestrator.log');
    await fs.writeFile(logFile, 'x'.repeat(20), 'utf8');

    const logger = createPersistentLogger({
      logFile,
      maxBytes: 10,
      console: { log() {}, warn() {}, error() {} },
      now: () => new Date('2026-07-10T00:00:00.000Z'),
    });

    logger.warn('rotated');

    assert.equal(await fs.readFile(`${logFile}.1`, 'utf8'), 'x'.repeat(20));
    const text = await fs.readFile(logFile, 'utf8');
    assert.match(text, /\[warn\] rotated/);
  });
});
