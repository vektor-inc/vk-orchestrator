/**
 * startKeepAwake（OS ごとのスリープ防止）のユニットテスト。
 *
 * 実際に子プロセスを起動せず、spawn / platform / env / logger を依存注入して
 * 「どのプラットフォームで何を起動するか」「無効化・未対応・起動失敗時の挙動」
 * 「stop() の後始末」を検証する。カバーするケース:
 *   - macOS  → caffeinate を PID 連動（-w）で起動
 *   - Windows → powershell + SetThreadExecutionState を PID 連動で起動
 *   - 無効化フラグ / 未対応プラットフォーム → 何も起動しない no-op handle
 *   - spawn 同期例外 → 握りつぶして no-op handle（本処理を止めない）
 *   - stop() は child.kill() を一度だけ呼ぶ（二重 kill しない）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  startKeepAwake,
  buildCaffeinateArgs,
  buildPowerShellScript,
  KEEP_AWAKE_DISABLE_ENV,
} from '../src/power/keep-awake.js';

const silentLogger = { log: () => {}, warn: () => {} };

// 呼び出しを記録する fake spawn と、返す fake child を作る。
function makeFakeSpawn() {
  const calls = [];
  const child = {
    killed: 0,
    on() {},
    kill() {
      this.killed += 1;
    },
  };
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return child;
  };
  return { spawn, calls, child };
}

describe('buildCaffeinateArgs', () => {
  it('アイドル・システムスリープ抑止と PID 連動待機の引数を組み立てる', () => {
    assert.deepEqual(buildCaffeinateArgs(4242), ['-i', '-s', '-w', '4242']);
  });
});

describe('buildPowerShellScript', () => {
  it('SetThreadExecutionState と親 PID の Wait-Process を含む', () => {
    const script = buildPowerShellScript(4242);
    assert.match(script, /SetThreadExecutionState/);
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    assert.match(script, /0x80000001/);
    assert.match(script, /Wait-Process -Id 4242/);
  });

  it('PID は数値化され、任意文字列を埋め込めない（インジェクション防止）', () => {
    const script = buildPowerShellScript('123; Remove-Item C:\\');
    // Number() 化で NaN になり、危険な文字列はそのまま埋め込まれない
    assert.doesNotMatch(script, /Remove-Item/);
  });
});

describe('startKeepAwake', () => {
  it('macOS では caffeinate を PID 連動で起動する', () => {
    const { spawn, calls } = makeFakeSpawn();
    const handle = startKeepAwake({
      platform: 'darwin',
      pid: 999,
      env: {},
      spawn,
      logger: silentLogger,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'caffeinate');
    assert.deepEqual(calls[0].args, ['-i', '-s', '-w', '999']);
    assert.equal(handle.child != null, true);
  });

  it('Windows では powershell + SetThreadExecutionState を起動する', () => {
    const { spawn, calls } = makeFakeSpawn();
    startKeepAwake({
      platform: 'win32',
      pid: 999,
      env: {},
      spawn,
      logger: silentLogger,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'powershell');
    const joined = calls[0].args.join(' ');
    assert.match(joined, /SetThreadExecutionState/);
    assert.match(joined, /Wait-Process -Id 999/);
  });

  it('無効化フラグが立っていれば何も起動しない', () => {
    const { spawn, calls } = makeFakeSpawn();
    const handle = startKeepAwake({
      platform: 'darwin',
      env: { [KEEP_AWAKE_DISABLE_ENV]: '1' },
      spawn,
      logger: silentLogger,
    });
    assert.equal(calls.length, 0);
    assert.equal(handle.child, null);
    // stop() は例外なく呼べる（no-op）
    handle.stop();
  });

  it('未対応プラットフォームでは何も起動せず no-op を返す', () => {
    const { spawn, calls } = makeFakeSpawn();
    const handle = startKeepAwake({
      platform: 'linux',
      env: {},
      spawn,
      logger: silentLogger,
    });
    assert.equal(calls.length, 0);
    assert.equal(handle.child, null);
  });

  it('spawn が例外を投げても握りつぶして no-op を返す', () => {
    const throwingSpawn = () => {
      throw new Error('ENOENT');
    };
    const handle = startKeepAwake({
      platform: 'darwin',
      env: {},
      spawn: throwingSpawn,
      logger: silentLogger,
    });
    assert.equal(handle.child, null);
    // 本処理を止めない＝例外が外に漏れない
    handle.stop();
  });

  it('stop() は child.kill() を一度だけ呼ぶ（二重 kill しない）', () => {
    const { spawn, child } = makeFakeSpawn();
    const handle = startKeepAwake({
      platform: 'darwin',
      env: {},
      spawn,
      logger: silentLogger,
    });
    handle.stop();
    handle.stop();
    assert.equal(child.killed, 1);
  });
});
