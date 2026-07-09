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
const CLEAR_INPUT_SEQUENCE = '\x01\x0b';

let originalFetch;
/**
 * scenario:
 *   - statesQueue: /api/states が呼ばれるたびに先頭から取り出して返す
 *                  ({ lastOutputTime, lastLines } or 'error' → fetch を reject)
 *   - sendCalls:   /api/send で受け取った body のログ
 *   - inputBuffer: VK Terminals 側の入力欄を模した蓄積バッファ
 *   - submittedInputs: Enter で確定された入力行
 *   - statesCalls: /api/states の呼び出し回数
 */
let scenario;

function mockFetch() {
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);

    if (u.endsWith('/api/states')) {
      scenario.statesCalls += 1;
      // 送信状況（=これまでに送られた本文/Enter の回数）でターミナル状態を差し替える。
      //   - Enter 未送信 & 本文 0 回:  beforeBody     （本文未送信時）
      //   - Enter 未送信 & 本文 1 回:  afterBody       （本文送信済み・Enter 未送信、baseline 取得タイミング）
      //   - Enter 未送信 & 本文 2 回以上: afterBodyRetry（本文再送後。未定義なら afterBody にフォールバック
      //                                    = 「再送しても画面は変わらない」動作になる）
      //   - Enter 送信済み（何回でも）:  afterEnter     （Enter 送信後の確認ポーリング）
      const bodySends  = scenario.sendCalls.filter(c => c.input !== '\r' && c.input !== CLEAR_INPUT_SEQUENCE).length;
      const enterSends = scenario.sendCalls.filter(c => c.input === '\r').length;
      const phase =
        enterSends > 0 ? 'afterEnter'
        : bodySends === 0 ? 'beforeBody'
        : bodySends === 1 ? 'afterBody'
        : 'afterBodyRetry';
      const value = scenario.statesByPhase[phase] ?? scenario.statesByPhase.afterBody;
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
      if (body.input === CLEAR_INPUT_SEQUENCE) {
        scenario.inputBuffer = '';
      } else if (body.input === '\r') {
        scenario.submittedInputs.push(scenario.inputBuffer);
        scenario.inputBuffer = '';
      } else {
        scenario.inputBuffer += body.input;
      }
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
    inputBuffer: '',
    submittedInputs: [],
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
    assert.equal(result.bodyConfirmed, true, 'エコーを確認できたので bodyConfirmed=true');

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
    assert.equal(result.bodyConfirmed, null, 'confirm:false では確認しないので bodyConfirmed=null');
    assert.equal(scenario.statesCalls, 0, 'confirm:false では /api/states が呼ばれない');
    assert.equal(scenario.sendCalls.length, 2, '本文 + Enter の 2 回のみ');
  });

  it('(e) [RED] コールドスタートのバナーが本文を飲み込み、Enterでバナーが消えるだけで出力は進む → 本文が再送されるべき（現行コードは見逃す）', async () => {
    // コールドスタート再現シナリオ:
    //   beforeBody / afterBody: 起動バナーが表示されたまま（本文 'hello' はどこにもエコーされない
    //   = 入力欄が出る前にペインへ送った本文が飲み込まれた状態）
    //   afterEnter: バナーが消えてプロンプトが再描画される（lastOutputTime も lastLines も変わる
    //   ため、現行の AND 判定では「出力が進んだ」と誤判定してしまう）が、ここにも 'hello' は
    //   一度も現れない＝本文は結局どこにも入力されていない。
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100, lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:  { lastOutputTime: 100, lastLines: 'Fable 5 is back and better than ever!' },
      afterEnter: { lastOutputTime: 900, lastLines: '> ' },
    };

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    const bodySends = scenario.sendCalls.filter(c => c.input === 'hello');
    assert.ok(
      bodySends.length >= 2,
      '本文が一度も画面にエコーされないまま出力だけ進んだ場合、Enter だけでなく本文ごと再送されるべき' +
      `（実際の本文送信回数: ${bodySends.length}）`
    );
    // 本文再送を使い切ってもエコーを確認できなかったので、呼び出し側が取りこぼしに
    // 気づけるよう bodyConfirmed=false を返す（#4 の握りつぶし防止）。
    assert.equal(result.bodyConfirmed, false,
      '再送を使い切ってもエコー未確認なら bodyConfirmed=false を返す');
  });

  it('(f) 本文が飲み込まれても 1 回の再送でエコーが確認できれば、それ以上は再送しない', async () => {
    // beforeBody/afterBody: バナー表示中で本文は飲み込まれる（エコーなし）。
    // afterBodyRetry: 本文を再送した結果、今度はプロンプトに 'hello' がエコーされる。
    // afterEnter: Enter 確定でさらに出力が進む。
    scenario.statesByPhase = {
      beforeBody:     { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:      { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterBodyRetry: { lastOutputTime: 500,   lastLines: 'prompt:hello' },
      afterEnter:     { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, 'hello', 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    assert.equal(result.bodyConfirmed, true, '再送でエコーを確認できたので bodyConfirmed=true');
    const bodySends = scenario.sendCalls.filter(c => c.input === 'hello');
    assert.equal(bodySends.length, 2, '飲み込まれた本文は 1 回だけ再送され、エコー確認後は再送を止める');
    // 本文(2回) + 再送前クリア(1回) + Enter(1回) の計 4 回のみ。
    // Enter 側は afterEnter で AND 判定 progressed=true のため再送なし。
    assert.equal(scenario.sendCalls.length, 4, 'エコー確認後は Enter も 1 回で成功し、余計な再送が起きない');
    assert.equal(scenario.sendCalls[1].input, CLEAR_INPUT_SEQUENCE, '本文再送の直前に入力行をクリアする');
  });

  it('本文再送時は入力行をクリアしてから再送し、Enter で確定される行を重複連結しない', async () => {
    const body = '/vk-kore https://github.com/vektor-inc/vk-blocks-pro/issues/123 wp-env-port=9100 headless=1';
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100, lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:  { lastOutputTime: 100, lastLines: 'Fable 5 is back and better than ever!' },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, body, 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    assert.equal(result.bodyConfirmed, false, 'エコー未確認のまま本文再送を使い切る');
    assert.deepEqual(
      scenario.submittedInputs,
      [body],
      '入力欄が追記型でも、Enter で確定されるコマンドは本文1回分だけになる'
    );
  });

  it('(g) 全トークンが4文字未満の本文 → エコー確認をスキップし本文再送しない（bodyConfirmed=true）', async () => {
    // 'ok a b' はすべて 4 文字未満 → pickEchoFragment は null を返し、
    // confirmBodyEchoed は「判定不能」としてフォールスルーで true。
    // バナー表示中で本文がエコーされていなくても、短トークンの偶然一致による
    // 誤判定を避けるため本文再送は起こさない。
    scenario.statesByPhase = {
      beforeBody: { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterBody:  { lastOutputTime: 100,   lastLines: 'Fable 5 is back and better than ever!' },
      afterEnter: { lastOutputTime: 2_000, lastLines: 'after-enter' },
    };

    const result = await submitToClaude(PORT, TERMID, 'ok a b', 10, FAST_OPTIONS);

    assert.equal(result.ok, true);
    assert.equal(result.bodyConfirmed, true, 'エコー確認をスキップしたので bodyConfirmed=true');
    const bodySends = scenario.sendCalls.filter(c => c.input === 'ok a b');
    assert.equal(bodySends.length, 1, '4 文字以上のトークンが無い本文は再送しない');
    // 本文(1回) + Enter(1回) の計 2 回。
    assert.equal(scenario.sendCalls.length, 2, 'エコー確認スキップ時は本文再送が発火しない');
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
