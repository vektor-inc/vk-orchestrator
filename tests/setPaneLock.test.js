/**
 * setPaneLock のユニットテスト。
 *
 * VK Terminals 側の閉じる保護は `/api/set-lock` の `lock.close` でのみ
 * 反映される。`/api/set-status` や `/api/set-title` へ混ぜず、指定された
 * lock 値をそのまま送ることを回帰検証する。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setPaneLock } from '../src/terminals/index.js';

const PORT   = 13847;
const TERMID = 'term-1';

let originalFetch;
let scenario;

function mockFetch() {
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    scenario.fetchUrls.push(u);

    if (u.endsWith('/api/set-lock')) {
      scenario.setLockCalls.push(init?.body ? JSON.parse(init.body) : {});
      return {
        ok: scenario.setLockOk,
        status: scenario.setLockStatus ?? 200,
        json: async () => {
          if (scenario.setLockJsonThrows) {
            throw new SyntaxError('mock invalid json');
          }
          return scenario.setLockResponse;
        },
      };
    }

    if (u.endsWith('/api/set-status')) {
      scenario.setStatusCalls += 1;
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
    fetchUrls:           [],
    statesCalls:         0,
    setStatusCalls:      0,
    setTitleCalls:       0,
    setLockCalls:        [],
    setLockOk:           true,
    setLockStatus:       200,
    setLockResponse:     { ok: true, termId: TERMID, lock: { close: false } },
    setLockJsonThrows:   false,
    ...overrides,
  };
}

describe('setPaneLock', () => {
  beforeEach(() => {
    resetScenario();
    mockFetch();
  });

  afterEach(() => {
    restoreFetch();
  });

  it('/api/set-lock に lock.close=false を送信し、他の状態系 API は叩かない', async () => {
    const result = await setPaneLock(PORT, TERMID, { close: false });

    assert.equal(result.ok, true);
    assert.equal(scenario.setLockCalls.length, 1, '/api/set-lock が 1 回呼ばれる');
    assert.equal(scenario.setStatusCalls, 0, '/api/set-status は呼ばれない');
    assert.equal(scenario.setTitleCalls, 0, '/api/set-title は呼ばれない');
    assert.equal(scenario.statesCalls, 0, '/api/states は呼ばれない');
    assert.ok(scenario.fetchUrls.some(url => url.endsWith('/api/set-lock')), '/api/set-lock が呼ばれる');
    assert.equal(scenario.fetchUrls.some(url => url.endsWith('/api/set-status')), false, '/api/set-status は呼ばれない');
    assert.equal(scenario.fetchUrls.some(url => url.endsWith('/api/set-title')), false, '/api/set-title は呼ばれない');
    assert.equal(scenario.fetchUrls.some(url => url.endsWith('/api/states')), false, '/api/states は呼ばれない');
    assert.deepEqual(scenario.setLockCalls[0], { termId: TERMID, lock: { close: false } });
  });

  it('lock=null を渡すと lock=null が送信される', async () => {
    await setPaneLock(PORT, TERMID, null);

    assert.deepEqual(scenario.setLockCalls[0], { termId: TERMID, lock: null });
  });

  it('set-lock が非 ok を返したらレスポンスの error で throw する', async () => {
    scenario.setLockOk = false;
    scenario.setLockStatus = 404;
    scenario.setLockResponse = { error: 'terminal term-1 not found' };

    await assert.rejects(
      () => setPaneLock(PORT, TERMID, { close: false }),
      /terminal term-1 not found/,
    );
  });

  it('非 ok レスポンスの JSON が読めなくても HTTP ステータスで throw する', async () => {
    scenario.setLockOk = false;
    scenario.setLockStatus = 500;
    scenario.setLockJsonThrows = true;

    await assert.rejects(
      () => setPaneLock(PORT, TERMID, { close: false }),
      /set-lock failed: HTTP 500/,
    );
  });
});
