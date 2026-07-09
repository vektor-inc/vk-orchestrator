/**
 * setExternalWaiting のユニットテスト。
 *
 * VK Terminals 側の入力待ちラベルは `/api/set-status` の `waiting` でのみ
 * externalWaiting に反映される。`/api/set-title` に相乗りさせても握りつぶされるため、
 * 以下を回帰検証する:
 *
 *   - 叩くエンドポイントが `/api/set-status` であること
 *   - `/api/set-title` と `/api/states` を叩かないこと
 *   - waiting が boolean に正規化されてペイロードに乗ること
 *   - set-status 自体が失敗したら throw すること
 *   - エラーレスポンスの JSON が読めなくても HTTP ステータスで throw すること
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setExternalWaiting } from '../src/terminals/index.js';

const PORT   = 13847;
const TERMID = 'term-1';

let originalFetch;
let scenario;

function mockFetch() {
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    scenario.fetchUrls.push(u);

    if (u.endsWith('/api/set-status')) {
      scenario.setStatusCalls.push(init?.body ? JSON.parse(init.body) : {});
      return {
        ok: scenario.setStatusOk,
        status: scenario.setStatusStatus ?? 200,
        json: async () => {
          if (scenario.setStatusJsonThrows) {
            throw new SyntaxError('mock invalid json');
          }
          return scenario.setStatusResponse;
        },
      };
    }

    if (u.endsWith('/api/set-title')) {
      scenario.setTitleCalls += 1;
    }
    if (u.endsWith('/api/states')) {
      scenario.statesCalls += 1;
    }
    throw new Error(`unexpected fetch url in test: ${u}`);
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function resetScenario(overrides = {}) {
  scenario = {
    fetchUrls:            [],
    statesCalls:          0,
    setTitleCalls:        0,
    setStatusCalls:       [],
    setStatusOk:          true,
    setStatusStatus:      200,
    setStatusResponse:    { ok: true, termId: TERMID, waiting: true },
    setStatusJsonThrows:  false,
    ...overrides,
  };
}

describe('setExternalWaiting', () => {
  beforeEach(() => {
    resetScenario();
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('/api/set-status に waiting=true を送信し、set-title と states は叩かない', async () => {
    const result = await setExternalWaiting(PORT, TERMID, true);

    assert.equal(result.ok, true);
    assert.equal(scenario.setStatusCalls.length, 1, '/api/set-status が 1 回呼ばれる');
    assert.equal(scenario.setTitleCalls, 0, '/api/set-title は呼ばれない');
    assert.equal(scenario.statesCalls, 0, '/api/states は呼ばれない');
    assert.ok(scenario.fetchUrls.some(url => url.endsWith('/api/set-status')), '/api/set-status が呼ばれる');
    assert.equal(scenario.fetchUrls.some(url => url.endsWith('/api/set-title')), false, '/api/set-title は呼ばれない');
    assert.equal(scenario.fetchUrls.some(url => url.endsWith('/api/states')), false, '/api/states は呼ばれない');
    assert.deepEqual(scenario.setStatusCalls[0], { termId: TERMID, waiting: true });
  });

  it('waiting=false を渡すと waiting=false が送信される', async () => {
    await setExternalWaiting(PORT, TERMID, false);

    assert.deepEqual(scenario.setStatusCalls[0], { termId: TERMID, waiting: false });
  });

  it('falsy/truthy 値を boolean に正規化して送信する', async () => {
    await setExternalWaiting(PORT, TERMID, 0);
    assert.equal(scenario.setStatusCalls[0].waiting, false, '0 は false に正規化');

    resetScenario();
    await setExternalWaiting(PORT, TERMID, null);
    assert.equal(scenario.setStatusCalls[0].waiting, false, 'null は false に正規化');

    resetScenario();
    await setExternalWaiting(PORT, TERMID, 1);
    assert.equal(scenario.setStatusCalls[0].waiting, true, '1 は true に正規化');
  });

  it('set-status が非 ok を返したらレスポンスの error で throw する', async () => {
    scenario.setStatusOk = false;
    scenario.setStatusStatus = 404;
    scenario.setStatusResponse = { error: 'terminal term-1 not found' };

    await assert.rejects(
      () => setExternalWaiting(PORT, TERMID, true),
      /terminal term-1 not found/,
    );
  });

  it('非 ok レスポンスの JSON が読めなくても HTTP ステータスで throw する', async () => {
    scenario.setStatusOk = false;
    scenario.setStatusStatus = 500;
    scenario.setStatusJsonThrows = true;

    await assert.rejects(
      () => setExternalWaiting(PORT, TERMID, true),
      /set-status failed: HTTP 500/,
    );
  });
});
