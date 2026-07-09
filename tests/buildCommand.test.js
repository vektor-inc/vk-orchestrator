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
import {
  buildCommand,
  assignWpEnvPort,
  collectReservedWpEnvPorts,
  expandTemplate,
  isPortAvailable,
} from '../src/engine/build-command.js';

// #7 の既定値と同じフラット構造 + wpEnv フラグ（#8）。
const DEFAULT_CFG = {
  commandTemplate: '/vk-kore {issueUrl} wp-env-port={wpPort} headless=1',
  portBase: 9100,
  portStride: 2,
  wpEnv: { enabled: true },
};

const ISSUE_URL = 'https://github.com/vektor-inc/vk-blocks-pro/issues/123';
const PORTS_AVAILABLE = { isPortAvailable: async () => true };

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

test('assignWpEnvPort: portBase/portStride を反映し、起点が空いていれば従来と同じポートを返す', async () => {
  assert.equal(await assignWpEnvPort(1, DEFAULT_CFG, PORTS_AVAILABLE), 9100);
  assert.equal(await assignWpEnvPort(2, DEFAULT_CFG, PORTS_AVAILABLE), 9102);
  assert.equal(await assignWpEnvPort(3, DEFAULT_CFG, PORTS_AVAILABLE), 9104);
  // 別の基準値・間隔
  assert.equal(await assignWpEnvPort(1, { ...DEFAULT_CFG, portBase: 9200, portStride: 4 }, PORTS_AVAILABLE), 9200);
  assert.equal(await assignWpEnvPort(3, { ...DEFAULT_CFG, portBase: 9200, portStride: 4 }, PORTS_AVAILABLE), 9208);
});

test('assignWpEnvPort: 起点ペアが埋まっている場合は次の空き候補ペアへフォールバックする', async () => {
  const occupied = new Set([9100, 9101]);
  const wpPort = await assignWpEnvPort(1, DEFAULT_CFG, {
    isPortAvailable: async (port) => !occupied.has(port),
  });
  assert.equal(wpPort, 9102);
});

test('assignWpEnvPort: 8888/8889 を候補ペアから除外する', async () => {
  const probed = [];
  const wpPort = await assignWpEnvPort(1, { ...DEFAULT_CFG, portBase: 8887, portStride: 1 }, {
    isPortAvailable: async (port) => {
      probed.push(port);
      return true;
    },
  });
  assert.equal(wpPort, 8890);
  assert.deepEqual(probed, [8890, 8891]);
});

test('assignWpEnvPort: 他アクティブタスクの予約ポートを避ける', async () => {
  const reservedPorts = collectReservedWpEnvPorts({
    33: { wpPort: 9100 },
    34: { wpPort: 9102 },
  }, 33);
  assert.deepEqual([...reservedPorts].sort((a, b) => a - b), [9102, 9103]);
  assert.equal(await assignWpEnvPort(1, DEFAULT_CFG, { ...PORTS_AVAILABLE, reservedPorts }), 9100);
  assert.equal(await assignWpEnvPort(2, DEFAULT_CFG, { ...PORTS_AVAILABLE, reservedPorts }), 9104);
});

test('assignWpEnvPort: 上限まで探索しても空きが無ければ例外を投げる', async () => {
  await assert.rejects(
    assignWpEnvPort(1, DEFAULT_CFG, {
      isPortAvailable: async () => false,
      maxScanAttempts: 3,
    }),
    /空きポートペアが見つかりません/
  );
});

test('assignWpEnvPort: portBase が 0 または負値なら設定不正として早期に例外を投げる', async () => {
  for (const portBase of [0, -9100]) {
    await assert.rejects(
      assignWpEnvPort(1, { ...DEFAULT_CFG, portBase }, PORTS_AVAILABLE),
      /wp-env ポート割り当て設定が不正です/
    );
  }
});

test('isPortAvailable: 範囲外ポートは同期 RangeError を漏らさず false に倒す', async () => {
  assert.equal(await isPortAvailable(70000), false);
});

test('buildCommand: 既定 config + issue URL → /vk-kore <url> wp-env-port=<port> headless=1', async () => {
  const { prompt, targetIssue, wpPort } = await buildCommand('タイトル', ISSUE_URL, 1, DEFAULT_CFG, undefined, PORTS_AVAILABLE);
  assert.equal(prompt, `/vk-kore ${ISSUE_URL} wp-env-port=9100 headless=1`);
  assert.equal(wpPort, 9100);
  assert.equal(targetIssue.url, ISSUE_URL);
  assert.equal(targetIssue.owner, 'vektor-inc');
  assert.equal(targetIssue.repo, 'vk-blocks-pro');
  assert.equal(targetIssue.number, 123);
});

test('buildCommand: termId に応じてポートがずれる', async () => {
  const { prompt, wpPort } = await buildCommand('t', ISSUE_URL, 2, DEFAULT_CFG, undefined, PORTS_AVAILABLE);
  assert.equal(wpPort, 9102);
  assert.equal(prompt, `/vk-kore ${ISSUE_URL} wp-env-port=9102 headless=1`);
});

test('buildCommand: wpEnv.enabled=false + {wpPort} 無しテンプレートで port 未割り当て', async () => {
  const cfg = {
    ...DEFAULT_CFG,
    commandTemplate: '/vk-kore {issueUrl} headless=1',
    wpEnv: { enabled: false },
  };
  const { prompt, wpPort, targetIssue } = await buildCommand('t', ISSUE_URL, 1, cfg);
  assert.equal(wpPort, null); // ポート割り当てなし → state に保存されずクリーンアップもスキップ
  assert.equal(prompt, `/vk-kore ${ISSUE_URL} headless=1`);
  assert.ok(targetIssue); // issue URL 自体は検出されている
});

test('buildCommand: wpEnv.enabled=false は任意スキル／素のプロンプトに差し替えられる', async () => {
  const cfg = {
    ...DEFAULT_CFG,
    commandTemplate: '/some-other-skill {issueUrl} extra',
    wpEnv: { enabled: false },
  };
  const { prompt, wpPort } = await buildCommand('t', ISSUE_URL, 5, cfg);
  assert.equal(wpPort, null);
  assert.equal(prompt, `/some-other-skill ${ISSUE_URL} extra`);
});

test('buildCommand: 第5引数 wpEnvEnabled=false は config より優先されポート未割り当て', async () => {
  // config は enabled:true でも、呼び出し側の自動判定結果（false）が勝つ。
  const { wpPort, prompt } = await buildCommand('t', ISSUE_URL, 1, DEFAULT_CFG, false);
  assert.equal(wpPort, null);
  // {wpPort} は値が無いのでテンプレートにそのまま残る（壊れない）。
  assert.equal(prompt, `/vk-kore ${ISSUE_URL} wp-env-port={wpPort} headless=1`);
});

test('buildCommand: 第5引数 wpEnvEnabled=true は config の false より優先されポート割り当て', async () => {
  const cfg = { ...DEFAULT_CFG, wpEnv: { enabled: false } };
  const { wpPort } = await buildCommand('t', ISSUE_URL, 2, cfg, true, PORTS_AVAILABLE);
  assert.equal(wpPort, 9102);
});

test('buildCommand: 第5引数省略時は taskConfig.wpEnv.enabled で判定する（後方互換）', async () => {
  // enabled: null（自動）→ !== false で有効扱い。
  const cfg = { ...DEFAULT_CFG, wpEnv: { enabled: null } };
  assert.equal((await buildCommand('t', ISSUE_URL, 1, cfg, undefined, PORTS_AVAILABLE)).wpPort, 9100);
  // enabled: false → 無効。
  const cfgOff = { ...DEFAULT_CFG, wpEnv: { enabled: false } };
  assert.equal((await buildCommand('t', ISSUE_URL, 1, cfgOff)).wpPort, null);
});

test('buildCommand: issue URL が無い汎用タスクはテンプレートを使わず title+body を送る', async () => {
  const { prompt, targetIssue, wpPort } = await buildCommand('やること', '本文だよ', 1, DEFAULT_CFG);
  assert.equal(prompt, 'やること\n\n本文だよ');
  assert.equal(targetIssue, null);
  assert.equal(wpPort, null);
});

test('buildCommand: 汎用タスクは body 無しなら title のみ', async () => {
  const { prompt } = await buildCommand('タイトルだけ', '', 1, DEFAULT_CFG);
  assert.equal(prompt, 'タイトルだけ');
});
