/**
 * waitForHealth のユニットテスト。
 *
 * `up` が GUI(Electron)を起動した後、orchestrator を起動する前に vk-terminals の
 * HTTP API 疎通を待つポーリングの挙動を検証する。疎通判定(check)と待機(sleep)を
 * 依存注入で差し替えて、実際の fetch / タイマーに依存せずテストする。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitForHealth } from '../src/terminals/index.js';

const PORT = 13847;

test('waitForHealth: 初回で healthy なら即 true（sleep しない）', async () => {
  let checks = 0;
  let sleeps = 0;
  const ok = await waitForHealth(PORT, {
    check: async () => { checks++; return true; },
    sleep: async () => { sleeps++; },
  });
  assert.equal(ok, true);
  assert.equal(checks, 1);
  assert.equal(sleeps, 0);
});

test('waitForHealth: 数回後に healthy になれば true を返す', async () => {
  let checks = 0;
  const ok = await waitForHealth(PORT, {
    timeoutMs: 60_000,
    intervalMs: 10,
    check: async () => { checks++; return checks >= 3; },
    sleep: async () => {},
  });
  assert.equal(ok, true);
  assert.equal(checks, 3);
});

test('waitForHealth: タイムアウトすると false を返す', async () => {
  let checks = 0;
  // timeoutMs=0 なら初回 false 後すぐ deadline 超過で終了する。
  const ok = await waitForHealth(PORT, {
    timeoutMs: 0,
    intervalMs: 10,
    check: async () => { checks++; return false; },
    sleep: async () => {},
  });
  assert.equal(ok, false);
  assert.equal(checks, 1);
});

test('waitForHealth: check が false の間は sleep を挟んで再試行する', async () => {
  let checks = 0;
  let sleeps = 0;
  const ok = await waitForHealth(PORT, {
    timeoutMs: 60_000,
    intervalMs: 5,
    check: async () => { checks++; return checks >= 2; },
    sleep: async () => { sleeps++; },
  });
  assert.equal(ok, true);
  assert.equal(checks, 2);
  assert.equal(sleeps, 1); // 1 回目 false → sleep → 2 回目 true
});
