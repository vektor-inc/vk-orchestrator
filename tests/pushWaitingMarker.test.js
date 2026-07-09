/**
 * pushWaitingMarker のユニットテスト。
 *
 * VK Terminals 側は `/api/set-title` の optional `waiting` フィールドで
 * 入力待ちマーカー状態を受け取る仕様（`title` / `url` / `prUrl` をペアで置換する
 * セマンティクス）。waiting だけを単独更新すると既存タイトル等を消してしまうため、
 * 以下を回帰検証する:
 *
 *   - 叩くエンドポイントが `/api/set-title` であること
 *   - 現在の apiTitle / apiUrl / apiPrUrl が getStates 経由で引き継がれること
 *   - waiting が boolean に正規化されてペイロードに乗ること
 *   - 該当 termId が見つからなければ throw すること
 *   - set-title 自体が失敗したら throw すること
 *   - `/api/states` の terminals が無い場合は明示的なエラーで reject すること
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { pushWaitingMarker } from '../src/terminals/index.js';

const PORT   = 13847;
const TERMID = 'term-1';

let originalFetch;
let scenario;

function mockFetch() {
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    scenario.fetchUrls.push(u);

    if (u.endsWith('/api/states')) {
      scenario.statesCalls += 1;
      if (scenario.statesResponse === 'error') {
        throw new Error('mock api/states error');
      }
      return {
        ok: true,
        json: async () => scenario.statesResponse,
      };
    }

    if (u.endsWith('/api/set-title')) {
      scenario.setTitleCalls.push(init?.body ? JSON.parse(init.body) : {});
      return {
        ok: scenario.setTitleOk,
        status: scenario.setTitleStatus ?? 200,
        json: async () => scenario.setTitleResponse,
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
    statesResponse: {
      terminals: {
        'pane-1': {
          termId:   TERMID,
          apiTitle: '#42 既存タイトル',
          apiUrl:   'https://github.com/vektor-inc/task-queue/issues/42',
          apiPrUrl: 'https://github.com/vektor-inc/foo/pull/123',
        },
      },
    },
    fetchUrls:        [],
    statesCalls:      0,
    setTitleCalls:    [],
    setTitleOk:       true,
    setTitleStatus:   200,
    setTitleResponse: { ok: true },
    ...overrides,
  };
}

describe('pushWaitingMarker', () => {
  beforeEach(() => {
    resetScenario();
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('現在の apiTitle / apiUrl / apiPrUrl を引き継いで /api/set-title に waiting=true をセットする', async () => {
    const result = await pushWaitingMarker(PORT, TERMID, true);

    assert.equal(result.ok, true);
    assert.equal(scenario.statesCalls, 1, 'getStates が 1 回呼ばれる');
    assert.equal(scenario.setTitleCalls.length, 1, '/api/set-title が 1 回呼ばれる');
    assert.ok(scenario.fetchUrls.some(url => url.endsWith('/api/states')), 'getStates が呼ばれる');
    assert.ok(scenario.fetchUrls.some(url => url.endsWith('/api/set-title')), '/api/set-title が呼ばれる');

    const payload = scenario.setTitleCalls[0];
    assert.equal(payload.termId, TERMID);
    assert.equal(payload.title, '#42 既存タイトル', 'apiTitle が維持される');
    assert.equal(payload.url, 'https://github.com/vektor-inc/task-queue/issues/42', 'apiUrl が維持される');
    assert.equal(payload.prUrl, 'https://github.com/vektor-inc/foo/pull/123', 'apiPrUrl が維持される');
    assert.equal(payload.waiting, true, 'waiting=true がペイロードに乗る');
  });

  it('waiting=false を渡すと waiting=false が送信される', async () => {
    await pushWaitingMarker(PORT, TERMID, false);

    const payload = scenario.setTitleCalls[0];
    assert.equal(payload.waiting, false);
    assert.equal(payload.title, '#42 既存タイトル');
    assert.equal(payload.url, 'https://github.com/vektor-inc/task-queue/issues/42');
    assert.equal(payload.prUrl, 'https://github.com/vektor-inc/foo/pull/123');
  });

  it('falsy 値を渡すと waiting=false に正規化される', async () => {
    await pushWaitingMarker(PORT, TERMID, 0);
    assert.equal(scenario.setTitleCalls[0].waiting, false, '0 は false に正規化');

    resetScenario();
    await pushWaitingMarker(PORT, TERMID, null);
    assert.equal(scenario.setTitleCalls[0].waiting, false, 'null は false に正規化');
  });

  it('該当 termId が見つからなければ throw する', async () => {
    scenario.statesResponse = {
      terminals: {
        'pane-1': { termId: 'other-term', apiTitle: 'x', apiUrl: '', apiPrUrl: '' },
      },
    };

    await assert.rejects(
      () => pushWaitingMarker(PORT, TERMID, true),
      /terminal term-1 not found/,
    );
    assert.equal(scenario.setTitleCalls.length, 0, 'set-title は呼ばれない');
  });

  it('set-title が非 ok を返したら throw する', async () => {
    scenario.setTitleOk = false;
    scenario.setTitleStatus = 400;
    scenario.setTitleResponse = { error: 'invalid waiting' };

    await assert.rejects(
      () => pushWaitingMarker(PORT, TERMID, true),
      /invalid waiting/,
    );
  });

  it('apiTitle / apiUrl / apiPrUrl が未設定でも空文字で送れる', async () => {
    scenario.statesResponse = {
      terminals: {
        'pane-1': { termId: TERMID },
      },
    };

    await pushWaitingMarker(PORT, TERMID, true);

    const payload = scenario.setTitleCalls[0];
    assert.equal(payload.title, '');
    assert.equal(payload.url, '');
    assert.equal(payload.prUrl, '');
    assert.equal(payload.waiting, true);
  });

  it('/api/states のレスポンスに terminals が無い場合は明示的なエラーで reject する', async () => {
    scenario.statesResponse = {}; // terminals フィールド欠落

    await assert.rejects(
      () => pushWaitingMarker(PORT, TERMID, true),
      /invalid states response from VK Terminals/,
    );
    assert.equal(scenario.setTitleCalls.length, 0, 'set-title は呼ばれない');

    // null の場合も同じく明示的に弾く（Object.values(null) の TypeError を防ぐ）
    resetScenario();
    scenario.statesResponse = { terminals: null };

    await assert.rejects(
      () => pushWaitingMarker(PORT, TERMID, true),
      /invalid states response from VK Terminals/,
    );
    assert.equal(scenario.setTitleCalls.length, 0);
  });
});
