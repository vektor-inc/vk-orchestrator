/**
 * buildPaneTitle のユニットテスト（issue #23）。
 *
 * ペインヘッダーに表示するタイトル・リンクを、元の作業対象 issue のもの／
 * task-queue メタ issue のもののどちらにするかを決める純粋関数。
 * 副作用が無いため build-command.js から直接 import して検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPaneTitle, stripControlChars } from '../src/engine/build-command.js';

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

// -------------------------------------------------------
// 多層防御: 外部由来の issue タイトルに制御文字が混ざっていても
// titleText からは除去される（issue #25）。URL 側は触らない。
// -------------------------------------------------------
test('buildPaneTitle: resolvedTarget 経路で titleText の制御文字（C0/DEL/C1）を除去する', () => {
  const resolvedTarget = {
    number: 123,
    // ESC・BEL・NUL・C1(\x9f) を織り交ぜた悪意ある／壊れたタイトル
    title: 'ボタン\x1b]0;evil\x07の\x00余白\x9fを修正',
    url: 'https://github.com/vektor-inc/vk-blocks-pro/issues/123',
  };
  const { titleText, url } = buildPaneTitle(META_ISSUE, resolvedTarget);
  assert.equal(titleText, '#123 ボタン]0;evilの余白を修正');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(titleText), `制御文字が残存: ${JSON.stringify(titleText)}`);
  // URL は素通し（スキーム検証済みのため触らない）
  assert.equal(url, 'https://github.com/vektor-inc/vk-blocks-pro/issues/123');
});

test('buildPaneTitle: メタ issue 経路で titleText の制御文字（C0/DEL/C1）を除去する', () => {
  const metaIssue = {
    number: 42,
    title: '[vk-blocks-pro] ボタン\x1bの\x07余白\x7fを修正\x9f',
    html_url: 'https://github.com/vektor-inc/task-queue/issues/42',
  };
  const { titleText, url } = buildPaneTitle(metaIssue, null);
  assert.equal(titleText, '#42 [vk-blocks-pro] ボタンの余白を修正');
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(titleText), `制御文字が残存: ${JSON.stringify(titleText)}`);
  assert.equal(url, 'https://github.com/vektor-inc/task-queue/issues/42');
});

// -------------------------------------------------------
// 共通ヘルパー stripControlChars の単体テスト（buildPaneTitleSequence と共有）
// -------------------------------------------------------
test('stripControlChars: C0/DEL/C1 を除去し、通常文字は残す', () => {
  assert.equal(stripControlChars('あ\x00い\x1fう\x7fえ\x80お\x9fか'), 'あいうえおか');
  assert.equal(stripControlChars('safe text 123'), 'safe text 123');
});

test('stripControlChars: 文字列以外も文字列化して扱う', () => {
  assert.equal(stripControlChars(123), '123');
});
