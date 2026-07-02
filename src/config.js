// 設定の一元化。
//
// vk-orchestrator は「単一の設定ファイル(config.json)」を正とし、そこから
//   1) 自分自身(オーケストレーター)のランタイム設定
//   2) vk-terminals 用の設定ファイル(vk-terminals のインストールディレクトリ内 config.json)
// の両方を賄う。秘密情報(GITHUB_TOKEN)だけは .env に置く（config.json はコミット対象に
// しやすいよう秘密を含めない設計）。
//
// 設定の優先順位: 明示的な環境変数 > config.json > 各既定値。
// （移設した engine 側は従来どおり process.env を読むため、applyConfigToEnv() で
//   config.json の値を process.env に流し込んでから engine を起動する。挙動は不変。）

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);

/**
 * config.json の探索順:
 *   1. 環境変数 VK_ORCHESTRATOR_CONFIG（明示指定）
 *   2. ~/.vk-orchestrator/config.json（ユーザー固有・推奨）
 *   3. <repo>/config.json（ローカル・.gitignore 対象）
 * @returns {string} 最初に見つかったパス（無ければ repo 直下のパスを返す）
 */
export function resolveConfigPath() {
  if (process.env.VK_ORCHESTRATOR_CONFIG) return process.env.VK_ORCHESTRATOR_CONFIG;
  const home = join(homedir(), '.vk-orchestrator', 'config.json');
  if (existsSync(home)) return home;
  return join(REPO_ROOT, 'config.json');
}

/**
 * 統合設定ファイルを読み込む。存在しなければ空オブジェクトを返す（全て既定/env に委ねる）。
 * @param {string} [path]
 * @returns {object}
 */
export function loadUnifiedConfig(path = resolveConfigPath()) {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`[Config] 設定ファイルの読み込みに失敗しました (${path}): ${err.message}`);
  }
}

/**
 * config.json の値を process.env に反映する。
 * 既に定義済みの環境変数は上書きしない（env > config.json）。
 * @param {object} cfg loadUnifiedConfig() の戻り値
 */
export function applyConfigToEnv(cfg = {}) {
  const set = (key, val) => {
    if (val === undefined || val === null) return;
    if (process.env[key] !== undefined && process.env[key] !== '') return;
    process.env[key] = String(val);
  };
  const gh = cfg.github ?? {};
  // トークンも config.json で一元管理できるようにする（config.json は .gitignore 対象）。
  // .env に GITHUB_TOKEN があればそちらが優先される（env > config.json）。
  set('GITHUB_TOKEN', gh.token);
  set('GITHUB_OWNER', gh.owner);
  set('GITHUB_REPO', gh.repo);
  set('SOURCE_ORG', gh.sourceOrg);
  set('QUEUE_LABEL', gh.queueLabel);

  const o = cfg.orchestrator ?? {};
  set('POLL_INTERVAL_MS', o.pollIntervalMs);
  set('WATCHDOG_IDLE_MS', o.watchdogIdleMs);
  set('ASSIGNEE_FILTER', o.assigneeFilter);

  const vk = cfg.vkTerminals ?? {};
  set('VK_TERMINALS_PORT', vk.port);
  set('VK_TERMINALS_HOST', vk.host);
}

/**
 * 統合設定の vkTerminals セクションから、vk-terminals が読む config.json の
 * オブジェクトを組み立てる。vk-terminals 側のキー名(apiHost 等)に変換する。
 * @param {object} cfg
 * @returns {object}
 */
export function toVkTerminalsConfig(cfg = {}) {
  const vk = cfg.vkTerminals ?? {};
  const out = {};
  if (vk.host !== undefined)           out.apiHost = vk.host;
  if (vk.initialCommand !== undefined) out.initialCommand = vk.initialCommand;
  if (vk.agentroom !== undefined)      out.agentroom = vk.agentroom;
  if (Array.isArray(vk.additionalPanes)) out.additionalPanes = vk.additionalPanes;
  return out;
}

/**
 * 同梱している vk-terminals のインストールディレクトリを解決する。
 * (optionalDependencies として導入される package の実体パス)
 * 未導入なら例外を投げる。
 * @returns {string} vk-terminals パッケージのルートディレクトリ
 */
export function resolveVkTerminalsDir() {
  return dirname(require.resolve('vk-terminals/package.json'));
}

/**
 * vk-terminals が読む設定ファイルの書き出し先。
 * 以前は ~/.vk-terminals/config.json（ユーザーごとに場所が変わる）へ書いていたが、
 * vk-terminals 自身のディレクトリ内 config.json を正とするため、そこへ書き出す。
 * @param {string} [vkDir] vk-terminals のインストールディレクトリ
 * @returns {string}
 */
export function vkTerminalsConfigPath(vkDir = resolveVkTerminalsDir()) {
  return join(vkDir, 'config.json');
}

/**
 * ~/.vk-terminals/config.json は vk-terminals の設定探索でインストールディレクトリ内
 * config.json より優先されるため、存在すると appDir 側へ書いた設定が無視される。
 * 存在すればそのパスを、無ければ null を返す（呼び出し側で警告するため）。
 * @returns {string|null}
 */
export function shadowingHomeConfigPath() {
  const p = join(homedir(), '.vk-terminals', 'config.json');
  return existsSync(p) ? p : null;
}

/**
 * 統合設定の vkTerminals セクションを、vk-terminals のインストールディレクトリ内
 * config.json へ書き出す。
 * @param {object} cfg loadUnifiedConfig() の戻り値
 * @param {string} [vkDir] vk-terminals のインストールディレクトリ
 * @returns {string} 書き出したパス
 */
export function writeVkTerminalsConfig(cfg = {}, vkDir = resolveVkTerminalsDir()) {
  const target = vkTerminalsConfigPath(vkDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(toVkTerminalsConfig(cfg), null, 2) + '\n');
  return target;
}

/**
 * vk-terminals の設定パネル用「設定ディスクリプタ」を組み立てる。
 *
 * vk-terminals 側は特定ツールの設定内容を知らない汎用パネルで、env
 * VK_TERMINALS_SETTINGS が指すこのディスクリプタ（targetPath + 項目スキーマ）に
 * 従って読み書きする。ここで vk-orchestrator の統合 config.json のスキーマを与える
 * ことで、GUI から config.json を直接手編集せずに済むようにする。
 *
 * @param {string} [targetPath] 編集対象の config.json パス（既定は解決済みパス）
 * @returns {object} 設定ディスクリプタ
 */
export function buildSettingsDescriptor(targetPath = resolveConfigPath()) {
  return {
    title: 'vk-orchestrator 設定',
    note: '保存後、orchestrator を再起動すると反映されます（vkTerminals 側の項目は次回 up/apply で反映）。',
    targetPath,
    groups: [
      {
        label: 'GitHub',
        fields: [
          { key: 'github.token',      label: 'Personal Access Token', type: 'password', help: 'repo スコープ', emptyToNull: true },
          { key: 'github.owner',      label: 'Owner',                 type: 'text' },
          { key: 'github.repo',       label: 'Repo',                  type: 'text' },
          { key: 'github.sourceOrg',  label: 'Source Org',            type: 'text' },
          { key: 'github.queueLabel', label: 'Queue Label',           type: 'text' },
        ],
      },
      {
        label: 'オーケストレーター',
        fields: [
          { key: 'orchestrator.pollIntervalMs',  label: 'ポーリング間隔 (ms)',  type: 'number' },
          { key: 'orchestrator.watchdogIdleMs',  label: 'ウォッチドッグ idle (ms)', type: 'number' },
          { key: 'orchestrator.assigneeFilter',  label: '担当者フィルタ (login)', type: 'text', help: '空で無効', emptyToNull: true },
        ],
      },
      {
        label: 'vk-terminals',
        fields: [
          { key: 'vkTerminals.port',            label: 'API ポート',          type: 'number' },
          { key: 'vkTerminals.host',            label: 'API ホスト',          type: 'text' },
          { key: 'vkTerminals.initialCommand',  label: '初期コマンド',        type: 'text' },
          { key: 'vkTerminals.agentroom',       label: 'エージェントルーム表示', type: 'boolean' },
          { key: 'vkTerminals.additionalPanes', label: '追加ペイン (JSON 配列)', type: 'json', help: '例: [{"cwd":"/path"}]' },
        ],
      },
    ],
  };
}

/**
 * 設定ディスクリプタを vk-terminals のインストールディレクトリへ書き出す。
 * up 実行時にここへ書き出し、env VK_TERMINALS_SETTINGS でパスを GUI へ渡す。
 * @param {string} [vkDir] vk-terminals のインストールディレクトリ
 * @param {string} [targetPath] 編集対象の config.json パス
 * @returns {string} 書き出したディスクリプタのパス
 */
export function writeSettingsDescriptor(vkDir = resolveVkTerminalsDir(), targetPath = resolveConfigPath()) {
  const descPath = join(vkDir, 'settings-descriptor.json');
  writeFileSync(descPath, JSON.stringify(buildSettingsDescriptor(targetPath), null, 2) + '\n');
  return descPath;
}

/**
 * env(＋事前に applyConfigToEnv 済みの config.json)から、オーケストレーターの
 * 構造化ランタイム設定を解決する。GITHUB_TOKEN 未設定なら例外。
 * @param {string[]} [argv]
 */
export function loadConfig(argv = process.argv) {
  const readArg = (name) => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(`--${name}=`.length);
    const idx = argv.indexOf(`--${name}`);
    if (idx !== -1 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
    return undefined;
  };

  const owner = process.env.GITHUB_OWNER ?? 'vektor-inc';
  const cfg = {
    githubToken:    process.env.GITHUB_TOKEN,
    owner,
    repo:           process.env.GITHUB_REPO ?? 'task-queue',
    sourceOrg:      process.env.SOURCE_ORG ?? owner,
    queueLabel:     process.env.QUEUE_LABEL ?? 'task-queue',
    vkPort:         Number(process.env.VK_TERMINALS_PORT ?? 13847),
    vkHost:         process.env.VK_TERMINALS_HOST ?? '127.0.0.1',
    pollInterval:   Number(process.env.POLL_INTERVAL_MS ?? 60_000),
    watchdogIdle:   Number(process.env.WATCHDOG_IDLE_MS ?? 3 * 60 * 60 * 1000),
    assigneeFilter: readArg('assignee') ?? process.env.ASSIGNEE_FILTER ?? null,
  };
  if (!cfg.githubToken) {
    throw new Error('[Config] GITHUB_TOKEN が未設定です。.env を確認してください。');
  }
  return cfg;
}
