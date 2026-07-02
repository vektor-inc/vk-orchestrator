/**
 * createNewPane のユニットテスト。
 *
 * `up` が GUI 内に orchestrator 用の「素のシェルペイン」を開けるよう、
 * noClaude オプションが /api/new-pane のリクエストボディに乗ることを検証する。
 * また従来の呼び出し（cwd のみ / 引数なし）で noClaude を勝手に付けないことも確認する。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createNewPane } from '../src/terminals/index.js';

const PORT = 13847;

let originalFetch;
let lastBody;

beforeEach(() => {
  originalFetch = global.fetch;
  lastBody = undefined;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (!u.endsWith('/api/new-pane')) {
      throw new Error(`unexpected fetch url in test: ${u}`);
    }
    lastBody = init?.body ? JSON.parse(init.body) : {};
    return { ok: true, json: async () => ({ ok: true, termId: 'term-9' }) };
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('createNewPane: noClaude:true をボディに乗せて termId を返す', async () => {
  const termId = await createNewPane(PORT, '/work/dir', { noClaude: true });
  assert.equal(termId, 'term-9');
  assert.deepEqual(lastBody, { cwd: '/work/dir', noClaude: true });
});

test('createNewPane: cwd のみ指定なら noClaude を付けない（後方互換）', async () => {
  await createNewPane(PORT, '/work/dir');
  assert.deepEqual(lastBody, { cwd: '/work/dir' });
});

test('createNewPane: 引数なしなら空ボディ（後方互換）', async () => {
  await createNewPane(PORT);
  assert.deepEqual(lastBody, {});
});

test('createNewPane: ok:false なら throw する', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: 'boom' }) });
  await assert.rejects(() => createNewPane(PORT), /boom/);
});
