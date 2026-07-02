/**
 * setTerminalPrUrl のユニットテスト。
 *
 * VK Terminals 側は `/api/set-title` の `prUrl` フィールドで PR URL を受け取る仕様
 * （`title` / `url` / `prUrl` をペアで置換するセマンティクス）。
 * 過去に `/api/set-pr-url` という存在しないエンドポイントを叩いて prUrl が
 * 反映されない不具合があったため、以下を回帰検証する:
 *
 *   - 叩くエンドポイントが `/api/set-title` であること
 *   - 現在の apiTitle / apiUrl が getStates 経由で引き継がれること
 *   - 指定した prUrl がペイロードに乗ること
 *   - 該当 termId が見つからなければ throw すること
 *   - set-title 自体が失敗したら throw すること
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setTerminalPrUrl } from '../src/terminals/index.js';

const PORT   = 13847;
const TERMID = 'term-1';

let originalFetch;
let scenario;

function mockFetch() {
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);

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
        },
      },
    },
    statesCalls:     0,
    setTitleCalls:   [],
    setTitleOk:      true,
    setTitleStatus:  200,
    setTitleResponse: { ok: true },
    ...overrides,
  };
}

describe('setTerminalPrUrl', () => {
  beforeEach(() => {
    resetScenario();
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('現在の apiTitle / apiUrl を引き継いで /api/set-title に prUrl をセットする', async () => {
    const prUrl = 'https://github.com/vektor-inc/foo/pull/123';
    const result = await setTerminalPrUrl(PORT, TERMID, prUrl);

    assert.equal(result.ok, true);
    assert.equal(scenario.statesCalls, 1, 'getStates が 1 回呼ばれる');
    assert.equal(scenario.setTitleCalls.length, 1, '/api/set-title が 1 回呼ばれる');

    const payload = scenario.setTitleCalls[0];
    assert.equal(payload.termId, TERMID);
    assert.equal(payload.title, '#42 既存タイトル', 'apiTitle が維持される');
    assert.equal(payload.url, 'https://github.com/vektor-inc/task-queue/issues/42', 'apiUrl が維持される');
    assert.equal(payload.prUrl, prUrl, 'prUrl がそのままペイロードに乗る');
  });

  it('prUrl に空文字 / null を渡すとクリア扱いで送信される', async () => {
    await setTerminalPrUrl(PORT, TERMID, '');
    assert.equal(scenario.setTitleCalls[0].prUrl, '', '空文字はそのまま空文字で送る');

    resetScenario();
    await setTerminalPrUrl(PORT, TERMID, null);
    assert.equal(scenario.setTitleCalls[0].prUrl, '', 'null は空文字にフォールバック');
  });

  it('該当 termId が見つからなければ throw する', async () => {
    scenario.statesResponse = {
      terminals: {
        'pane-1': { termId: 'other-term', apiTitle: 'x', apiUrl: '' },
      },
    };

    await assert.rejects(
      () => setTerminalPrUrl(PORT, TERMID, 'https://example.com/pr/1'),
      /terminal term-1 not found/,
    );
    assert.equal(scenario.setTitleCalls.length, 0, 'set-title は呼ばれない');
  });

  it('set-title が非 ok を返したら throw する（呼び出し側で warn できるよう error を上に伝える）', async () => {
    scenario.setTitleOk = false;
    scenario.setTitleStatus = 400;
    scenario.setTitleResponse = { error: 'invalid prUrl' };

    await assert.rejects(
      () => setTerminalPrUrl(PORT, TERMID, 'not-a-url'),
      /invalid prUrl/,
    );
  });

  it('apiTitle / apiUrl が未設定でも空文字で送れる', async () => {
    scenario.statesResponse = {
      terminals: {
        'pane-1': { termId: TERMID },
      },
    };

    await setTerminalPrUrl(PORT, TERMID, 'https://example.com/pr/1');

    const payload = scenario.setTitleCalls[0];
    assert.equal(payload.title, '');
    assert.equal(payload.url, '');
    assert.equal(payload.prUrl, 'https://example.com/pr/1');
  });

  it('/api/states のレスポンスに terminals が無い場合は明示的なエラーで reject する', async () => {
    scenario.statesResponse = {}; // terminals フィールド欠落

    await assert.rejects(
      () => setTerminalPrUrl(PORT, TERMID, 'https://example.com/pr/1'),
      /invalid states response from VK Terminals/,
    );
    assert.equal(scenario.setTitleCalls.length, 0, 'set-title は呼ばれない');

    // null の場合も同じく明示的に弾く（Object.values(null) の TypeError を防ぐ）
    resetScenario();
    scenario.statesResponse = { terminals: null };

    await assert.rejects(
      () => setTerminalPrUrl(PORT, TERMID, 'https://example.com/pr/1'),
      /invalid states response from VK Terminals/,
    );
    assert.equal(scenario.setTitleCalls.length, 0);
  });

  it('termId は文字列・数値どちらでも apiTitle/apiUrl を引き継げる', async () => {
    scenario.statesResponse = {
      terminals: {
        'pane-1': { termId: '7', apiTitle: 't', apiUrl: 'u' },
      },
    };

    await setTerminalPrUrl(PORT, 7, 'https://example.com/pr/1');

    const payload = scenario.setTitleCalls[0];
    assert.equal(payload.title, 't');
    assert.equal(payload.url, 'u');
  });
});
