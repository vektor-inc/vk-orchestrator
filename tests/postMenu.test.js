/**
 * postMenu のユニットテスト。
 *
 * VK Terminals の `/api/menu` は source ごとにサイドバーセクションを丸ごと置換する
 * 冪等 API。ここでは orchestrator 側が正しいエンドポイント・HTTP メソッド・JSON body で
 * 投稿し、API エラーを呼び出し側へ throw できることを検証する。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { postMenu } from '../src/terminals/index.js';

const PORT = 13847;
const SECTION = {
  source: 'vk-orchestrator',
  title: 'VK Orchestrator',
  items: [
    {
      id: 'task-queue',
      label: 'task-queue',
      icon: '📋',
      action: { type: 'open-url', url: 'https://github.com/vektor-inc/task-queue/issues' },
    },
  ],
};

let originalFetch;
let lastRequest;

beforeEach(() => {
  originalFetch = global.fetch;
  lastRequest = undefined;
  global.fetch = async (url, init) => {
    lastRequest = { url: String(url), init };
    return { ok: true, status: 200, json: async () => ({ ok: true, source: 'vk-orchestrator' }) };
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('postMenu: /api/menu にセクション payload を JSON POST する', async () => {
  const result = await postMenu(PORT, SECTION, { timeoutMs: 1_000 });

  assert.deepEqual(result, { ok: true, source: 'vk-orchestrator' });
  assert.ok(lastRequest.url.endsWith('/api/menu'));
  assert.equal(lastRequest.init.method, 'POST');
  assert.equal(lastRequest.init.headers['Content-Type'], 'application/json');

  const body = JSON.parse(lastRequest.init.body);
  assert.equal(body.source, 'vk-orchestrator');
  assert.deepEqual(body.items, SECTION.items);
  assert.ok(lastRequest.init.signal instanceof AbortSignal, 'timeout 用の AbortSignal を渡す');
});

test('postMenu: レスポンス JSON が ok:false なら throw する', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: false, error: 'boom' }),
  });

  await assert.rejects(() => postMenu(PORT, SECTION), /boom/);
});

test('postMenu: HTTP エラーなら throw する', async () => {
  global.fetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ ok: false }),
  });

  await assert.rejects(() => postMenu(PORT, SECTION), /menu post failed: HTTP 500/);
});
