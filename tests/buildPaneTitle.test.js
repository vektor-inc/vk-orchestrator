/**
 * buildPaneTitle のユニットテスト（issue #23）。
 *
 * ペインヘッダーに表示するタイトル・リンクを、元の作業対象 issue のもの／
 * task-queue メタ issue のもののどちらにするかを決める純粋関数。
 * 副作用が無いため build-command.js から直接 import して検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaneTitle } from '../src/engine/build-command.js';

const META_ISSUE = {
  number: 42,
  title: '[vk-blocks-pro] ボタンの余白を修正',
  html_url: 'https://github.com/vektor-inc/task-queue/issues/42',
};

test('buildPaneTitle: resolvedTarget があれば元 issue の #番号 タイトルと url を返す', () => {
  const resolvedTarget = {
    number: 123,
    title: 'ボタンの余白を修正',
    url: 'https://github.com/vektor-inc/vk-blocks-pro/issues/123',
  };
  const { titleText, url } = buildPaneTitle(META_ISSUE, resolvedTarget);
  assert.equal(titleText, '#123 ボタンの余白を修正');
  assert.equal(url, 'https://github.com/vektor-inc/vk-blocks-pro/issues/123');
});

test('buildPaneTitle: resolvedTarget が null ならメタ issue の #番号 タイトルと html_url を返す', () => {
  const { titleText, url } = buildPaneTitle(META_ISSUE, null);
  assert.equal(titleText, '#42 [vk-blocks-pro] ボタンの余白を修正');
  assert.equal(url, 'https://github.com/vektor-inc/task-queue/issues/42');
});
