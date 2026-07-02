/**
 * waitForClaudeReady のユニットテスト。
 *
 * createNewPane 直後に Claude Code の TUI 起動完了（入力待ち）を待つ readiness ゲートの挙動を
 * 検証する。`global.fetch` をモックし、/api/states が返す端末状態の遷移を制御する。
 *
 * 判定方針: 出力が一度現れてから quietMs 以上「無変化」が続いたら入力待ちとみなす
 *（特定の TUI 文字列に依存しないバージョン非依存の判定）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { waitForClaudeReady } from '../src/terminals/index.js';

const PORT   = 13847;
const TERMID = 'term-1';

let originalFetch;
// statesQueue: /api/states 呼び出しごとに先頭から取り出して返す端末状態。
//   各要素は { lastOutputTime, lastLines } か 'error'（fetch を reject）か 'gone'（端末消失）。
//   キューを尽きたら最後の要素を返し続ける。
let statesQueue;

function mockFetch() {
  originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (!u.endsWith('/api/states')) {
      throw new Error(`unexpected fetch url in test: ${u}`);
    }
    const value = statesQueue.length > 1 ? statesQueue.shift() : statesQueue[0];
    if (value === 'error') {
      throw new Error('mock api/states error');
    }
    if (value === 'gone') {
      return { ok: true, json: async () => ({ terminals: {} }) };
    }
    return {
      ok: true,
      json: async () => ({
        terminals: {
          [TERMID]: {
            termId:         TERMID,
            waiting:        false,
            lastOutputTime: value.lastOutputTime,
            lastLines:      value.lastLines,
          },
        },
      }),
    };
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

// テスト高速化用の共通オプション
const FAST = { readyTimeoutMs: 2_000, quietMs: 120, pollIntervalMs: 30 };

describe('waitForClaudeReady', () => {
  beforeEach(() => mockFetch());
  afterEach(() => restoreFetch());

  it('出力が現れて静止 → true（readiness 確認）', async () => {
    // 起動直後の描画（出力変化）後、同じ状態を返し続けて静止させる。
    statesQueue = [
      { lastOutputTime: 1_000, lastLines: 'starting...' },
      { lastOutputTime: 2_000, lastLines: 'Welcome to Claude Code' },
      { lastOutputTime: 2_000, lastLines: 'Welcome to Claude Code' }, // 以降この静止状態が続く
    ];
    const ready = await waitForClaudeReady(PORT, TERMID, FAST);
    assert.equal(ready, true);
  });

  it('出力が変化し続ける（静止しない）→ タイムアウトで false', async () => {
    // 毎回 lastOutputTime / lastLines が変わり続け、quietMs の静止が来ないケース。
    let t = 1_000;
    statesQueue = [];
    // キューを十分長くして、尽きても「変化し続ける」状態を維持するため
    // 最後の要素も毎回変わるよう、フェッチ側で動的生成する代わりに十分な数を積む。
    for (let i = 0; i < 200; i++) {
      statesQueue.push({ lastOutputTime: (t += 100), lastLines: `line-${i}` });
    }
    const ready = await waitForClaudeReady(PORT, TERMID, FAST);
    assert.equal(ready, false, '静止しないままタイムアウト');
  });

  it('出力が一度も現れない（空のまま）→ タイムアウトで false', async () => {
    // lastLines が空白のままなら sawOutput=false で readiness とみなさない。
    statesQueue = [{ lastOutputTime: 0, lastLines: '' }];
    const ready = await waitForClaudeReady(PORT, TERMID, FAST);
    assert.equal(ready, false);
  });

  it('ペインが消えたまま（連続して見つからない）→ false（送信側の判断に委ねる）', async () => {
    // termId が states に出続けない＝消失とみなす。起動直後の未反映と区別するため
    // 数回（maxConsecutiveMisses）連続で見つからなければ false を返す。
    statesQueue = ['gone'];
    const ready = await waitForClaudeReady(PORT, TERMID, FAST);
    assert.equal(ready, false);
  });

  it('API 一時エラーはスキップして継続し、静止すれば true', async () => {
    statesQueue = [
      'error',
      { lastOutputTime: 1_000, lastLines: 'rendered' },
      { lastOutputTime: 1_000, lastLines: 'rendered' }, // 静止
    ];
    const ready = await waitForClaudeReady(PORT, TERMID, FAST);
    assert.equal(ready, true);
  });
});
