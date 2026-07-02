/**
 * submitToClaude のユニットテスト。
 *
 * `global.fetch` をモックして、HTTP I/O を伴わない形で Enter 再送リトライの
 * 挙動を検証する。
 *
 * 想定エンドポイントは下記 2 つ:
 *   - POST /api/send   : 本文 / Enter 送信
 *   - GET  /api/states : baseline 取得 & 出力進行確認
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { submitToClaude } from '../src/terminals/index.js';

// --------------------------------------------------------------------------
// fetch モックの仕込み
// --------------------------------------------------------------------------

const PORT   = 13847;
const TERMID = 'term-1';

let originalFetch;
/**
 * scenario:
 *   - statesQueue: /api/states が呼ばれるたびに先頭から取り出して返す
 *                  ({ lastOutputTime, lastLines } or 'error' → fetch を reject)
 *   - sendCalls:   /api/send で受け取った body のログ
 *   - statesCalls: /api/states の呼び出し回数
 */
let scenario;

function mockFetch() {
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);

    if (u.endsWith('/api/states')) {
      scenario.statesCalls += 1;
      // 送信状況（=現在「いくつ /api/send が呼ばれたか」）でターミナル状態を差し替える。
      //   - sendCalls 0:   本文未送信時（baseline を本文送信前に取りに来る旧コード向け）
      //   - sendCalls 1:   本文送信済み・Enter 未送信（baseline を Enter 直前に取りに来る新コード向け）
      //   - sendCalls 2+:  Enter 送信後の確認ポーリング
      const phase =
        scenario.sendCalls.length === 0 ? 'beforeBody'
        : scenario.sendCalls.length === 1 ? 'afterBody'
        : 'afterEnter';
      const value = scenario.statesByPhase[phase];
      if (value === 'error') {
        throw new Error('mock api/states error');
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
    }

    if (u.endsWith('/api/send')) {
      const body = init && init.body ? JSON.parse(init.body) : {};
      scenario.sendCalls.push(body);
      return {
        ok: true,
        json: async () => ({ ok: true }),
      };
    }

    throw new Error(`unexpected fetch url in test: ${u}`);
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function resetScenario(overrides = {}) {
  scenario = {
    statesByPhase: {
      beforeBody: { lastOutputTime: 100,   lastLines: 'idle'         },
      afterBody:  { lastOutputTime: 1_000, lastLines: 'prompt:hello' },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter'  },
    },
    statesCalls: 0,
    sendCalls:   [],
    ...overrides,
  };
}

// テストを高速化するための共通オプション
const FAST_OPTIONS = {
  confirmTimeoutMs: 200,
  pollIntervalMs:   50,
  maxRetries:       2,
};

// --------------------------------------------------------------------------
// テスト
// --------------------------------------------------------------------------

describe('submitToClaude', () => {
  beforeEach(() => {
    resetScenario();
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('(a) 本文送信で lastLines が変わり、Enter 送信でも変わる → 1 回で成功（再送なし）', async () => {
    // デフォルトのシナリオ: beforeBody(idle) → afterBody(prompt) → afterEnter(after-enter)
    // baseline は afterBody(prompt:hello, 1_000) で取られ、
    // Enter 後ポーリングは afterEnter(after-enter, 2_000) で AND 判定 progressed=true
    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true, '送信結果が ok で返る');

    // /api/send は 本文 + Enter の計 2 回
    assert.equal(scenario.sendCalls.length, 2, '再送なしで Enter は 1 回だけ送られる');
    assert.equal(scenario.sendCalls[0].input, 'hello');
    assert.equal(scenario.sendCalls[1].input, '\r');
  });

  it('(b) 本文送信で lastLines が変わるが Enter 送信では変わらない → maxRetries 分再送される（旧コードでは失敗するケース）', async () => {
    // afterEnter を afterBody と同一にすることで「Enter が効いていない」状況を再現。
    //
    //   新コード（baseline = afterBody）:
    //     afterBody と afterEnter が同値 → progressed=false → maxRetries 分再送 (期待)
    //
    //   旧コード（baseline = beforeBody）:
    //     beforeBody='idle' / afterEnter='prompt:hello' → lastLines が違う
    //     → OR 判定で progressed=true となり、Enter は再送されない（FAIL）
    scenario.statesByPhase.afterEnter = { ...scenario.statesByPhase.afterBody };

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true, '最終的に return される（プロセスは落とさない）');

    // /api/send の内訳:
    //   1 回目: 本文
    //   2 回目: 最初の Enter
    //   3 回目: 再送 1 回目
    //   4 回目: 再送 2 回目（maxRetries=2）
    // 合計 4 回。Enter は計 3 回（最初の Enter + 再送 maxRetries=2）。
    assert.equal(scenario.sendCalls.length, 1 + 1 + FAST_OPTIONS.maxRetries,
      'maxRetries の回数だけ Enter が再送される');
    assert.equal(scenario.sendCalls[0].input, 'hello');
    for (let i = 1; i < scenario.sendCalls.length; i++) {
      assert.equal(scenario.sendCalls[i].input, '\r', `${i} 回目の send は Enter`);
    }
  });

  it('(c) baseline 取得が API エラー → 確認スキップで成功扱い（再送なし）', async () => {
    // baseline 取得タイミング（=本文送信後・Enter 前）の応答だけエラーにする
    scenario.statesByPhase.afterBody = 'error';

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    // 本文 + Enter のみ。再送は走らない（baseline=null なら confirmOutputProgressed は true）
    assert.equal(scenario.sendCalls.length, 2, '再送なしで終わる');
    assert.equal(scenario.sendCalls[1].input, '\r');
  });

  it('(d) confirm: false を渡すと従来通り即 return（baseline 取得もスキップ）', async () => {
    // baseline 取得が呼ばれていれば statesCalls が増える
    const result = await submitToClaude(PORT, TERMID, 'hello', 10, {
      ...FAST_OPTIONS,
      confirm: false,
    });

    assert.equal(result.ok, true);
    assert.equal(scenario.statesCalls, 0, 'confirm:false では /api/states が呼ばれない');
    assert.equal(scenario.sendCalls.length, 2, '本文 + Enter の 2 回のみ');
  });

  it('AND 判定: lastOutputTime だけ進んで lastLines が同じ場合は progressed と見なさない', async () => {
    // baseline (afterBody) と Enter 後 (afterEnter) で lastOutputTime だけ進んで lastLines は同じ
    // → カーソル blink 相当。AND 判定なので progressed=false で再送が走るのが正解。
    scenario.statesByPhase.afterEnter = {
      lastOutputTime: scenario.statesByPhase.afterBody.lastOutputTime + 5_000,
      lastLines:      scenario.statesByPhase.afterBody.lastLines,
    };

    await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    // OR 判定のままだと再送 0 回で終わる。AND 判定であれば maxRetries 分再送される。
    assert.equal(scenario.sendCalls.length, 1 + 1 + FAST_OPTIONS.maxRetries,
      'AND 判定なのでカーソル blink 相当のケースでは再送が発火する');
  });
});
