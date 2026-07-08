/**
 * VK Terminals サイドバーメニュー payload のユニットテスト。
 *
 * POST /api/menu は VK Terminals 側で source 単位の丸ごと置換として扱われるため、
 * orchestrator 側では常に完全なセクション payload を組み立てる。ここでは初期項目の
 * task-queue issue 一覧リンクと、VK Terminals の allowlist 制約に沿う値を検証する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MENU_SOURCE,
  buildOrchestratorMenu,
  taskQueueIssuesUrl,
} from '../src/engine/menu.js';

test('buildOrchestratorMenu: VK Orchestrator セクションと task-queue 項目を組み立てる', () => {
  const section = buildOrchestratorMenu({ owner: 'vektor-inc', repo: 'task-queue' });

  assert.equal(section.source, 'vk-orchestrator');
  assert.equal(section.title, 'VK Orchestrator');
  assert.equal(section.items.length, 1);

  const [item] = section.items;
  assert.equal(item.id, 'task-queue');
  assert.equal(item.label, 'task-queue');
  assert.equal(item.icon, '📋');
  assert.equal(item.action.type, 'open-url');
  assert.equal(item.action.url, 'https://github.com/vektor-inc/task-queue/issues');
});

test('buildOrchestratorMenu: owner/repo を変えると issue 一覧 URL が追従する', () => {
  const section = buildOrchestratorMenu({ owner: 'foo', repo: 'bar' });
  assert.equal(section.items[0].action.url, 'https://github.com/foo/bar/issues');
});

test('buildOrchestratorMenu: VK Terminals の API 制約に沿う action を返す', () => {
  const section = buildOrchestratorMenu({ owner: 'vektor-inc', repo: 'task-queue' });
  const action = section.items[0].action;

  assert.equal(action.type, 'open-url', 'allowlist 済みの open-url を使う');
  assert.ok(action.url.startsWith('https://'), 'URL は https で始まる');
});

test('MENU_SOURCE と taskQueueIssuesUrl の固定値を返す', () => {
  assert.equal(MENU_SOURCE, 'vk-orchestrator');
  assert.equal(taskQueueIssuesUrl('a', 'b'), 'https://github.com/a/b/issues');
});
