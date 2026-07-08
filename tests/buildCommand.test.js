/**
 * buildCommand / assignWpEnvPort / expandTemplate のユニットテスト。
 *
 * これらは taskConfig を DI 可能な純粋関数として build-command.js に分離・export されている
 * （engine/index.js からも再 export される）。engine/index.js は import しただけで
 * orchestrator 本体を自走させる（副作用実行）ため、テストは副作用の無い build-command.js から
 * 直接 import する。config.json / env に依存させず、taskConfig を明示的に渡して検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, assignWpEnvPort, expandTemplate } from '../src/engine/build-command.js';

// #7 の既定値と同じフラット構造 + wpEnv フラグ（#8）。
const DEFAULT_CFG = {
  commandTemplate: '/vk-kore {issueUrl} wp-env-port={wpPort} headless=1',
  portBase: 9100,
  portStride: 2,
  wpEnv: { enabled: true },
};

const ISSUE_URL = 'https://github.com/vektor-inc/vk-blocks-pro/issues/123';

test('expandTemplate: {issueUrl}/{wpPort} を置換する', () => {
  assert.equal(
    expandTemplate('/vk-kore {issueUrl} wp-env-port={wpPort}', { issueUrl: 'U', wpPort: 9100 }),
    '/vk-kore U wp-env-port=9100'
  );
});

test('expandTemplate: 値が null/undefined のプレースホルダは元のまま残す（壊れない）', () => {
  assert.equal(expandTemplate('/vk-kore {issueUrl}', { issueUrl: 'U', wpPort: null }), '/vk-kore U');
  // {wpPort} が残っていても例外を投げない
  assert.equal(
    expandTemplate('/x {issueUrl} p={wpPort}', { issueUrl: 'U', wpPort: null }),
    '/x U p={wpPort}'
  );
});

test('expandTemplate: 未知プレースホルダは元のまま残す', () => {
  assert.equal(expandTemplate('a {unknown} b', { issueUrl: 'U' }), 'a {unknown} b');
});

test('assignWpEnvPort: portBase/portStride を反映する', () => {
  assert.equal(assignWpEnvPort(1, DEFAULT_CFG), 9100);
  assert.equal(assignWpEnvPort(2, DEFAULT_CFG), 9102);
  assert.equal(assignWpEnvPort(3, DEFAULT_CFG), 9104);
  // 別の基準値・間隔
  assert.equal(assignWpEnvPort(1, { ...DEFAULT_CFG, portBase: 9200, portStride: 4 }), 9200);
  assert.equal(assignWpEnvPort(3, { ...DEFAULT_CFG, portBase: 9200, portStride: 4 }), 9208);
});

test('buildCommand: 既定 config + issue URL → /vk-kore <url> wp-env-port=<port> headless=1', () => {
  const { prompt, targetIssue, wpPort } = buildCommand('タイトル', ISSUE_URL, 1, DEFAULT_CFG);
  assert.equal(prompt, `/vk-kore ${ISSUE_URL} wp-env-port=9100 headless=1`);
  assert.equal(wpPort, 9100);
  assert.equal(targetIssue.url, ISSUE_URL);
  assert.equal(targetIssue.owner, 'vektor-inc');
  assert.equal(targetIssue.repo, 'vk-blocks-pro');
  assert.equal(targetIssue.number, 123);
});

test('buildCommand: termId に応じてポートがずれる', () => {
  const { prompt, wpPort } = buildCommand('t', ISSUE_URL, 2, DEFAULT_CFG);
  assert.equal(wpPort, 9102);
  assert.equal(prompt, `/vk-kore ${ISSUE_URL} wp-env-port=9102 headless=1`);
});

test('buildCommand: wpEnv.enabled=false + {wpPort} 無しテンプレートで port 未割り当て', () => {
  const cfg = {
    ...DEFAULT_CFG,
    commandTemplate: '/vk-kore {issueUrl} headless=1',
    wpEnv: { enabled: false },
  };
  const { prompt, wpPort, targetIssue } = buildCommand('t', ISSUE_URL, 1, cfg);
  assert.equal(wpPort, null); // ポート割り当てなし → state に保存されずクリーンアップもスキップ
  assert.equal(prompt, `/vk-kore ${ISSUE_URL} headless=1`);
  assert.ok(targetIssue); // issue URL 自体は検出されている
});

test('buildCommand: wpEnv.enabled=false は任意スキル／素のプロンプトに差し替えられる', () => {
  const cfg = {
    ...DEFAULT_CFG,
    commandTemplate: '/some-other-skill {issueUrl} extra',
    wpEnv: { enabled: false },
  };
  const { prompt, wpPort } = buildCommand('t', ISSUE_URL, 5, cfg);
  assert.equal(wpPort, null);
  assert.equal(prompt, `/some-other-skill ${ISSUE_URL} extra`);
});

test('buildCommand: 第5引数 wpEnvEnabled=false は config より優先されポート未割り当て', () => {
  // config は enabled:true でも、呼び出し側の自動判定結果（false）が勝つ。
  const { wpPort, prompt } = buildCommand('t', ISSUE_URL, 1, DEFAULT_CFG, false);
  assert.equal(wpPort, null);
  // {wpPort} は値が無いのでテンプレートにそのまま残る（壊れない）。
  assert.equal(prompt, `/vk-kore ${ISSUE_URL} wp-env-port={wpPort} headless=1`);
});

test('buildCommand: 第5引数 wpEnvEnabled=true は config の false より優先されポート割り当て', () => {
  const cfg = { ...DEFAULT_CFG, wpEnv: { enabled: false } };
  const { wpPort } = buildCommand('t', ISSUE_URL, 2, cfg, true);
  assert.equal(wpPort, 9102);
});

test('buildCommand: 第5引数省略時は taskConfig.wpEnv.enabled で判定する（後方互換）', () => {
  // enabled: null（自動）→ !== false で有効扱い。
  const cfg = { ...DEFAULT_CFG, wpEnv: { enabled: null } };
  assert.equal(buildCommand('t', ISSUE_URL, 1, cfg).wpPort, 9100);
  // enabled: false → 無効。
  const cfgOff = { ...DEFAULT_CFG, wpEnv: { enabled: false } };
  assert.equal(buildCommand('t', ISSUE_URL, 1, cfgOff).wpPort, null);
});

test('buildCommand: issue URL が無い汎用タスクはテンプレートを使わず title+body を送る', () => {
  const { prompt, targetIssue, wpPort } = buildCommand('やること', '本文だよ', 1, DEFAULT_CFG);
  assert.equal(prompt, 'やること\n\n本文だよ');
  assert.equal(targetIssue, null);
  assert.equal(wpPort, null);
});

test('buildCommand: 汎用タスクは body 無しなら title のみ', () => {
  const { prompt } = buildCommand('タイトルだけ', '', 1, DEFAULT_CFG);
  assert.equal(prompt, 'タイトルだけ');
});
