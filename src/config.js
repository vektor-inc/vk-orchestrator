// 設定の一元化。
//
// VK Orchestrator は「単一の設定ファイル(config.json)」を正とし、そこから
//   1) 自分自身(オーケストレーター)のランタイム設定
//   2) VK Terminals 用の設定ファイル(VK Terminals のインストールディレクトリ内 config.json)
// の両方を賄う。秘密情報(GITHUB_TOKEN)は gh auth login または .env に置く
// （config.json はコミット対象にしやすいよう秘密を含めない設計）。
//
// 設定の優先順位: 明示的な環境変数 / .env > config.json > gh auth token > 各既定値。
// （移設した engine 側は従来どおり process.env を読むため、applyConfigToEnv() で
//   config.json の値を process.env に流し込んでから engine を起動する。挙動は不変。）

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { resolve, dirname, join, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const require = createRequire(import.meta.url);
export const DEFAULT_VENDORED_VK_AGENTS_DIR = join(REPO_ROOT, 'vendor', 'vk-agents-public');

export const GITHUB_TOKEN_RESOLUTION_HELP = 'GitHub トークンを解決できません。gh CLI 未導入の場合は `brew install gh`（Ubuntu: `sudo apt install gh`）でインストールし、`gh auth login` で認証してください。';

// -------------------------------------------------------
// 汎用化に向けた設定セクションの既定値。
//
// これらは現時点で engine / github が「ハードコードしている値」をそのまま複製した
// ものであり、config.json に何も書かなければ getter は必ずこの既定値を返す
// （＝単体では挙動不変）。実際にこの既定値を engine / github の呼び出し箇所へ
// 反映するのは後続 sub-issue (#1〜#5) の仕事で、この issue では「枠」だけを用意する。
// -------------------------------------------------------

/**
 * task セクションの既定値。
 * vk-kore へ渡すコマンドテンプレートと wp-env ポート割り当ての基準値。
 */
export const DEFAULT_TASK = {
  // src/engine/index.js の `/vk-kore ${targetIssue.url} wp-env-port=${wpPort} headless=1` に対応。
  // {issueUrl} / {wpPort} は消費側で置換し、headless=1 は無人モードの正式トリガーとして渡す。
  commandTemplate: '/vk-kore {issueUrl} wp-env-port={wpPort} headless=1',
  // src/engine/index.js の assignWpEnvPort: 9100 + (termId-1)*2 に対応。
  portBase: 9100,
  portStride: 2,
  // wp-env 連携の ON/OFF。既定 null＝自動判定（タスク着手時に対象リポの `.wp-env.json`
  // 有無を見て決める。WordPress 案件なら ON、そうでなければ OFF）。config.json / 環境変数で
  // true / false を明示指定すると自動判定より優先する脱出ハッチになる。有効時はポート
  // 割り当て・{wpPort} 展開・マージ後クリーンアップを行い、無効時はそれらを一切行わず
  // {wpPort} を含まないテンプレートに差し替えることで vk-kore 以外のスキル／素のプロンプトも起動できる。
  wpEnv: { enabled: null },
};

/**
 * protocol セクションの既定値。
 * decision-record の Status 行のトークン（decision-record.js に対応）。
 * 判定は単独 `Status:` 行のみに依存し、識別行マーカーは撤去済み（#9）。
 */
export const DEFAULT_PROTOCOL = {
  // src/engine/decision-record.js の STATUS_LINE_RE の `Status:` 接頭辞に対応。
  statusLinePrefix: 'Status:',
  statusTokens: {
    waitingInput: 'waiting-input',
    noAction: 'no-action',
    answered: 'answered',
  },
};

/**
 * labels セクションの既定値。
 * task-queue のステータス/優先度ラベルと、対象リポ側の作業中ラベル。
 * エージェントレビュー完了マーカー（ラベル名・SHA 接頭辞）は config 化せず、src/github/index.js の
 * 固定定数（REVIEW_PASSED_LABEL / REVIEW_PASSED_SHA_PREFIX）のまま運用する。
 */
export const DEFAULT_LABELS = {
  status: {
    awaitingApproval: 'status:awaiting-approval',
    ready: 'status:ready',
    inProgress: 'status:in-progress',
    waitingInput: 'status:waiting-input',
    waitingMerge: 'status:waiting-merge',
    done: 'status:done',
    failed: 'status:failed',
  },
  priority: {
    high: 'priority:high',
    medium: 'priority:medium',
    low: 'priority:low',
  },
  automerge: 'automerge',
  sequential: 'sequential',
  parallel: 'parallel',
  // 対象リポ側に付ける作業中ラベル（src/github/index.js）。既定は英語の 'working'。
  // config.json の labels.workingInProgress で任意名に上書き可能（GUI には出さない隠しオプション）。
  workingInProgress: 'working',
};

/**
 * プレーンオブジェクトどうしを再帰的にディープマージする内部ヘルパ。
 * override 側のプレーンオブジェクトのみ再帰し、配列・スカラ・null は置換する。
 * base は破壊せず新しいオブジェクトを返す。
 * @param {object} base 既定値
 * @param {object} override 上書き値（config.json 由来）
 * @returns {object}
 */
function deepMerge(base, override) {
  const isPlain = (v) =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlain(override)) return isPlain(base) ? { ...base } : base;
  const out = isPlain(base) ? { ...base } : {};
  for (const [key, val] of Object.entries(override)) {
    // プロトタイプ汚染の多層防御: 危険キーは絶対にマージしない。
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (isPlain(val) && isPlain(out[key])) {
      out[key] = deepMerge(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * config.json 由来の override から「空とみなす値」を再帰的に除去する。
 *
 * VK Terminals(GUI) の設定パネルは汎用エディタで、保存時にディスクリプタ上の全項目を
 * 書き戻す。ユーザーが未入力の項目は空文字 / 空配列 / null として保存され、そのまま
 * deepMerge すると既定値（DEFAULT_TASK / DEFAULT_PROTOCOL / DEFAULT_LABELS）を空で
 * 上書きしてしまう（例: `labels.status: []`, `task.commandTemplate: ""`）。
 * これらを「未指定」とみなして取り除き、既定へフォールバックさせるための前処理。
 * false / 0 は有意な値として残す（enabled:false 等を潰さない）。
 * @param {*} v
 * @returns {*} 空を除去した値（全体が空なら undefined）
 */
function pruneEmpty(v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (Array.isArray(v)) {
    const arr = v.map(pruneEmpty).filter((x) => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      // deepMerge と同様にプロトタイプ汚染キーは扱わない。
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const pv = pruneEmpty(val);
      if (pv !== undefined) out[k] = pv;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v; // 非空の string / number(0 含む) / boolean(false 含む)
}

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
    if (val === undefined || val === null || val === '') return;
    if (process.env[key] !== undefined && process.env[key] !== '') return;
    process.env[key] = String(val);
  };
  const gh = cfg.github ?? {};
  // 後方互換のため github.token は引き続き読むが、新規設定では gh auth login を推奨する。
  // .env に GITHUB_TOKEN があればそちらが優先される（env/.env > config.json）。
  set('GITHUB_TOKEN', gh.token);
  set('GITHUB_OWNER', gh.owner);
  set('GITHUB_REPO', gh.repo);
  set('SOURCE_ORG', gh.sourceOrg);
  set('QUEUE_LABEL', gh.queueLabel);

  const o = cfg.orchestrator ?? {};
  set('POLL_INTERVAL_MS', o.pollIntervalMs);
  set('WATCHDOG_IDLE_MS', o.watchdogIdleMs);
  set('PANE_RESUME_MAX', o.paneResumeMax);
  set('ASSIGNEE_FILTER', o.assigneeFilter);
  set('TASK_CWD', o.taskCwd);

  const vk = cfg.vkTerminals ?? {};
  set('VK_TERMINALS_PORT', vk.port);
  set('VK_TERMINALS_HOST', vk.host);
}

/**
 * 統合設定の vkTerminals セクションから、VK Terminals が読む config.json の
 * オブジェクトを組み立てる。VK Terminals 側のキー名(apiHost 等)に変換する。
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

// -------------------------------------------------------
// GUI(Electron) の GPU 起動モード。
//
// VK Terminals(GUI) は Electron アプリで、Chromium が起動時に GPU を初期化する。
// macOS では HW アクセラがそのまま効くが、WSLg 等の Linux では GPU 初期化に失敗し
// `Exiting GPU process` / `kTransientFailure` などのエラーが多発する（利用可能な
// Vulkan ICD がソフトウェア実装のみで SwiftShader へフォールバックするため）。
// ここでは起動モードを config(vkTerminals.gpu) / env(VK_TERMINALS_GPU) で選べるようにし、
// bin 側の spawn 引数と追加環境変数へ写像する。GPU モードは VK Terminals 側の config.json
// には書き出さない（orchestrator が GUI を spawn する時点の起動オプションのため）。
// -------------------------------------------------------

/** GPU 起動モードの取りうる値。 */
export const GPU_MODES = ['off', 'default'];

/**
 * GPU 起動モードのプラットフォーム既定値を返す。
 * macOS は HW アクセラがそのまま効くためフラグ不要（'default'）。
 * それ以外（WSLg 等の Linux）は Chromium の GPU 初期化失敗によるエラーを抑制するため
 * 既定で GPU を無効化する（'off'）。
 * @param {string} [platform] process.platform 互換の値
 * @returns {'off'|'default'}
 */
export function defaultGpuMode(platform = process.platform) {
  return platform === 'darwin' ? 'default' : 'off';
}

// 未知の GPU モードを警告済みか（プロセス内で一度だけ通知するためのフラグ）。
let warnedUnknownGpuMode = false;

/**
 * GUI 起動時の GPU モードを解決する。
 * 優先順位: 環境変数 VK_TERMINALS_GPU > config.json(vkTerminals.gpu) > プラットフォーム既定。
 * 空文字・未知の値はプラットフォーム既定にフォールバックする。撤去した 'hardware' など
 * 非空の未知値が来た場合は、挙動変更に気づけるよう一度だけ警告する（起動は止めない）。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @param {string} [platform] process.platform 互換の値
 * @returns {'off'|'default'}
 */
export function getVkTerminalsGpuMode(cfg = loadUnifiedConfig(), platform = process.platform) {
  const raw = String(process.env.VK_TERMINALS_GPU ?? cfg?.vkTerminals?.gpu ?? '')
    .trim()
    .toLowerCase();
  if (GPU_MODES.includes(raw)) return raw;
  // 空（＝自動）は正常。非空の未知値（例: 旧 'hardware'）だけ一度警告してフォールバック。
  const fallback = defaultGpuMode(platform);
  if (raw !== '' && !warnedUnknownGpuMode) {
    warnedUnknownGpuMode = true;
    console.warn(
      `[Config] 未知の GPU モード "${raw}" は無視し、既定 "${fallback}" を使用します` +
      `（有効値: ${GPU_MODES.join(' / ')}、空=自動）。`
    );
  }
  return fallback;
}

/**
 * GPU モードから、Electron(GUI) 起動時に渡すフラグと追加環境変数を組み立てる。
 *  - 'off'      : GPU を無効化してエラーログを抑制する（描画はソフトウェア。
 *                 ターミナル用途では実害なし）。
 *  - 'default'  : フラグ・env を足さず Chromium 任せ（macOS 既定 / 明示的に素の挙動）。
 *
 * ※ WSLg での HW アクセラは対応しない。Vulkan は HW ICD（dzn 等）が提供されず、
 *    OpenGL もターミナル用途では体感差が無く、WSLg では Mesa/Dawn 由来の警告も出る
 *    ため。GPU を使いたい場合は 'default'（Chromium 任せ）を選ぶ。
 * @param {string} mode 'off'|'default'
 * @returns {{ args: string[], env: Record<string,string> }}
 */
export function gpuLaunchOptions(mode) {
  switch (mode) {
    case 'off':
      return { args: ['--disable-gpu', '--disable-software-rasterizer'], env: {} };
    case 'default':
    default:
      return { args: [], env: {} };
  }
}

/**
 * 同梱している VK Terminals のインストールディレクトリを解決する。
 * (optionalDependencies として導入される package の実体パス)
 * 未導入なら例外を投げる。
 * @returns {string} VK Terminals パッケージのルートディレクトリ
 */
export function resolveVkTerminalsDir() {
  return dirname(require.resolve('vk-terminals/package.json'));
}

/**
 * VK Terminals が読む設定ファイルの書き出し先。
 * 以前は ~/.vk-terminals/config.json（ユーザーごとに場所が変わる）へ書いていたが、
 * VK Terminals 自身のディレクトリ内 config.json を正とするため、そこへ書き出す。
 * @param {string} [vkDir] VK Terminals のインストールディレクトリ
 * @returns {string}
 */
export function vkTerminalsConfigPath(vkDir = resolveVkTerminalsDir()) {
  return join(vkDir, 'config.json');
}

/**
 * ~/.vk-terminals/config.json は VK Terminals の設定探索でインストールディレクトリ内
 * config.json より優先されるため、存在すると appDir 側へ書いた設定が無視される。
 * 存在すればそのパスを、無ければ null を返す（呼び出し側で警告するため）。
 * @returns {string|null}
 */
export function shadowingHomeConfigPath() {
  const p = join(homedir(), '.vk-terminals', 'config.json');
  return existsSync(p) ? p : null;
}

/**
 * 統合設定の vkTerminals セクションを、VK Terminals のインストールディレクトリ内
 * config.json へ書き出す。
 * @param {object} cfg loadUnifiedConfig() の戻り値
 * @param {string} [vkDir] VK Terminals のインストールディレクトリ
 * @returns {string} 書き出したパス
 */
export function writeVkTerminalsConfig(cfg = {}, vkDir = resolveVkTerminalsDir()) {
  const target = vkTerminalsConfigPath(vkDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(toVkTerminalsConfig(cfg), null, 2) + '\n');
  return target;
}

function getByPath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function hasOwnPath(obj, path) {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, key)) {
      return false;
    }
    cur = cur[key];
  }
  return true;
}

function setByPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur[key] == null || typeof cur[key] !== 'object' || Array.isArray(cur[key])) {
      cur[key] = {};
    }
    cur = cur[key];
  }
  cur[keys.at(-1)] = value;
}

function deleteByPath(obj, path) {
  const keys = path.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[key];
  }
  if (cur != null && typeof cur === 'object') delete cur[keys.at(-1)];
}

function readJsonObject(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    throw new Error(`[Config] JSON ファイルの読み込みに失敗しました (${path}): ${err.message}`);
  }
}

function writeJsonAtomic(path, obj) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx' });
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // temp が作られる前の失敗、または rename 済みなら削除不要。
    }
    throw err;
  }
}

function detectVkAgentsRepoPath() {
  const candidates = [
    join(dirname(REPO_ROOT), 'vk-agents'),
    join(dirname(dirname(REPO_ROOT)), 'vk-agents'),
    join(homedir(), 'Documents', 'git', 'vk-agents'),
    join(homedir(), 'Documents', 'claude', 'vk-agents'),
    DEFAULT_VENDORED_VK_AGENTS_DIR,
  ];
  return candidates.find((dir) => existsSync(join(dir, 'scripts', 'sync.sh'))) ?? null;
}

/**
 * vk-agents リポジトリのパスを解決する。
 * 優先順位: env VK_AGENTS_DIR/VK_AGENTS_REPO_PATH > config(vkAgents.repoPath) > 既知の兄弟配置。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {string|null}
 */
export function resolveVkAgentsRepoPath(cfg = loadUnifiedConfig()) {
  const raw =
    process.env.VK_AGENTS_DIR ??
    process.env.VK_AGENTS_REPO_PATH ??
    cfg?.vkAgents?.repoPath ??
    '';
  const explicit = String(raw).trim();
  if (explicit) return resolve(explicit);
  return detectVkAgentsRepoPath();
}

/**
 * vk-agents の個人設定 config.json パスを解決する。
 * 優先順位: env VK_AGENTS_CONFIG/VK_AGENTS_CONFIG_PATH > config(vkAgents.configPath)
 * > 解決済み vk-agents リポジトリ直下 config.json。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {string|null}
 */
export function resolveVkAgentsConfigPath(cfg = loadUnifiedConfig()) {
  const raw =
    process.env.VK_AGENTS_CONFIG ??
    process.env.VK_AGENTS_CONFIG_PATH ??
    cfg?.vkAgents?.configPath ??
    '';
  const explicit = String(raw).trim();
  if (explicit) return resolve(explicit);
  const repoPath = resolveVkAgentsRepoPath(cfg);
  return repoPath ? join(repoPath, 'config.json') : null;
}

/**
 * vk-agents の Claude グローバル派生設定パス。
 * sync.sh --claude-global と同じ場所へ、vk-agents config.json の投影として書く。
 * @param {string} [homeDir]
 * @returns {string}
 */
export function vkAgentsGlobalSettingsPath(homeDir = homedir()) {
  return join(homeDir, '.claude', 'vk-agents-settings.json');
}

/**
 * sync.sh --claude-global が更新するスキルマニフェストのパス。
 * @param {string} [homeDir]
 * @returns {string}
 */
export function vkAgentsSkillsManifestPath(homeDir = homedir()) {
  return join(homeDir, '.claude', 'skills', '.agent-skills-manifest');
}

/**
 * orchestrator が管理する、スキル展開元記録のサイドカーファイル。
 * sync.sh は .agent-skills-manifest を毎回上書きするため、別ファイルに分離する。
 * @param {string} [homeDir]
 * @returns {string}
 */
export function vkAgentsSkillsManifestSourcePath(homeDir = homedir()) {
  return join(homeDir, '.claude', 'skills', '.agent-skills-manifest-source');
}

/**
 * up 起動時の未セットアップ判定。
 * manifest があれば、展開元サイドカーの有無に関係なくセットアップ済みとみなす。
 * @param {{ manifestPath?: string, homeDir?: string }} [options]
 * @returns {boolean}
 */
export function isVkAgentsSetup(options = {}) {
  const manifestPath = options.manifestPath ?? vkAgentsSkillsManifestPath(options.homeDir);
  return existsSync(manifestPath);
}

/**
 * setup:agents 実行後に、sync.sh に消されないサイドカーへ展開元を記録する。
 * @param {string} sourcePath
 * @param {{ sourceRecordPath?: string, homeDir?: string, now?: Date }} [options]
 * @returns {string}
 */
export function writeVkAgentsManifestSource(sourcePath, options = {}) {
  const sourceRecordPath =
    options.sourceRecordPath ?? vkAgentsSkillsManifestSourcePath(options.homeDir);
  const payload = {
    sourcePath: resolve(sourcePath),
    writtenAt: (options.now ?? new Date()).toISOString(),
  };
  writeJsonAtomic(sourceRecordPath, payload);
  return sourceRecordPath;
}

function normalizedStringArray(value) {
  if (!Array.isArray(value)) return null;
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '');
}

function firstOwnedValue(obj, paths) {
  for (const path of paths) {
    if (hasOwnPath(obj, path)) return getByPath(obj, path);
  }
  return undefined;
}

// owner/repo 形式の受理条件（単一ソース）。
// descriptor の pattern（GUI 側の入力検証）と、GUI 保存値を vk-agents config へ投影する
// applyVkAgentsGuiSettings の受理判定を同一ソースにするため、正規表現を文字列定数で 1 箇所に定義する。
// descriptor は JSON 直列化されるため RegExp オブジェクトではなく文字列で保持する必要がある。
// 先頭の否定先読みで owner が `.`/`..`、末尾の否定先読みで repo が `.`/`..` になるケースを弾き、
// `..foo/repo` のような正規なリポジトリ名は通す（旧・二段ガードと論理等価であることを検証済み）。
const OWNER_REPO_PATTERN = '^(?!\\.{1,2}/)[A-Za-z0-9._-]+/(?!\\.{1,2}$)[A-Za-z0-9._-]+$';
const OWNER_REPO_RE = new RegExp(OWNER_REPO_PATTERN);

function applyVkAgentsGuiSettings(vkAgentsConfig, cfg) {
  const out = deepMerge({}, vkAgentsConfig);

  if (hasOwnPath(cfg, 'features')) {
    const rawFeatures = pruneEmpty(getByPath(cfg, 'features'));
    if (rawFeatures && typeof rawFeatures === 'object' && !Array.isArray(rawFeatures)) {
      setByPath(out, 'features', deepMerge(getByPath(out, 'features') ?? {}, rawFeatures));
    }
  }

  // GUI の boolean 保存値が文字列になる古い設定も受け入れる。
  if (hasOwnPath(cfg, 'features.coderabbit')) {
    const raw = getByPath(cfg, 'features.coderabbit');
    if (raw === 'true' || raw === 'false') {
      setByPath(out, 'features.coderabbit', raw === 'true');
    }
  }
  if (hasOwnPath(cfg, 'features.coderabbit_ignore')) {
    const raw = getByPath(cfg, 'features.coderabbit_ignore');
    if (raw === 'true' || raw === 'false') {
      setByPath(out, 'features.coderabbit_ignore', raw === 'true');
    }
  }

  const disabledSkills = normalizedStringArray(firstOwnedValue(cfg, [
    'vkAgents.disabledSkills',
    'vkAgents.skills.disabled',
    'skills.disabled',
  ]));
  if (disabledSkills) {
    setByPath(out, 'skills.disabled', disabledSkills);
  }

  const allowedOwners = normalizedStringArray(firstOwnedValue(cfg, [
    'vkAgents.allowedOwners',
    'vkAgents.allowed_owners',
    'vkAgents.org.allowed_owners',
    'org.allowed_owners',
  ]));
  if (allowedOwners) {
    setByPath(out, 'org.allowed_owners', allowedOwners);
  }

  for (const key of ['org.review_assets_repo', 'org.orchestrator_repo']) {
    if (!hasOwnPath(cfg, key)) continue;
    const raw = String(getByPath(cfg, key) ?? '').trim();
    if (raw === '') {
      deleteByPath(out, key);
    } else if (OWNER_REPO_RE.test(raw)) {
      // 受理条件は OWNER_REPO_PATTERN に単一ソース化済み（descriptor の pattern と同一）。
      setByPath(out, key, raw);
    }
  }

  if (hasOwnPath(cfg, 'staff_wp_dev.engine')) {
    const raw = String(getByPath(cfg, 'staff_wp_dev.engine') ?? '').trim();
    if (raw === '') {
      deleteByPath(out, 'staff_wp_dev.engine');
    } else if (raw === 'claude' || raw === 'codex') {
      setByPath(out, 'staff_wp_dev.engine', raw);
    }
  }

  if (hasOwnPath(cfg, 'multi_repo_task.default_engine')) {
    const raw = String(getByPath(cfg, 'multi_repo_task.default_engine') ?? '').trim();
    if (raw === '') {
      deleteByPath(out, 'multi_repo_task.default_engine');
    } else if (raw === 'claude' || raw === 'codex') {
      setByPath(out, 'multi_repo_task.default_engine', raw);
    }
  }

  return out;
}

/**
 * 統合 config.json の vk-agents 共通設定を、vk-agents リポジトリの config.json へ投影する。
 *
 * vk-agents の config.json を正本として read-merge-write し、GUI が扱うキーだけを更新する。
 * そのうえで sync.sh --claude-global と同じく ~/.claude/vk-agents-settings.json へ同内容を
 * 派生ファイルとして書き出す（reader はこの派生ファイルを読むため）。
 * @param {object} cfg loadUnifiedConfig() の戻り値
 * @param {{ configPath?: string, globalSettingsPath?: string, force?: boolean }} [options]
 * @returns {{ configPath: string, globalSettingsPath: string }|null}
 */
export function writeVkAgentsSettings(cfg = {}, options = {}) {
  const configPath = options.configPath ?? resolveVkAgentsConfigPath(cfg);
  if (!configPath) return null;

  const hasConfig = existsSync(configPath);
  const hasGuiSettings =
    hasOwnPath(cfg, 'features') ||
    hasOwnPath(cfg, 'vkAgents.disabledSkills') ||
    hasOwnPath(cfg, 'vkAgents.skills.disabled') ||
    hasOwnPath(cfg, 'vkAgents.allowedOwners') ||
    hasOwnPath(cfg, 'vkAgents.allowed_owners') ||
    hasOwnPath(cfg, 'vkAgents.org.allowed_owners') ||
    hasOwnPath(cfg, 'skills.disabled') ||
    hasOwnPath(cfg, 'org.allowed_owners') ||
    hasOwnPath(cfg, 'org.review_assets_repo') ||
    hasOwnPath(cfg, 'org.orchestrator_repo') ||
    hasOwnPath(cfg, 'staff_wp_dev.engine') ||
    hasOwnPath(cfg, 'multi_repo_task.default_engine');
  if (!hasConfig && !hasGuiSettings && options.force !== true) return null;

  let vkAgentsConfig;
  try {
    vkAgentsConfig = readJsonObject(configPath);
  } catch (err) {
    console.warn(`[vk-agents] ${configPath} が不正な JSON のため設定投影をスキップしました: ${err.message}`);
    return null;
  }

  const next = applyVkAgentsGuiSettings(vkAgentsConfig, cfg);
  writeJsonAtomic(configPath, next);

  const globalSettingsPath = options.globalSettingsPath ?? vkAgentsGlobalSettingsPath();
  writeJsonAtomic(globalSettingsPath, next);

  return { configPath, globalSettingsPath };
}

/**
 * VK Terminals の設定パネル用「設定ディスクリプタ」を組み立てる。
 *
 * VK Terminals 側は特定ツールの設定内容を知らない汎用パネルで、env
 * VK_TERMINALS_SETTINGS が指すこのディスクリプタ（targetPath + 項目スキーマ）に
 * 従って読み書きする。ここで VK Orchestrator の統合 config.json のスキーマを与える
 * ことで、GUI から config.json を直接手編集せずに済むようにする。
 *
 * @param {string} [targetPath] 編集対象の config.json パス（既定は解決済みパス）
 * @returns {object} 設定ディスクリプタ
 */
export function buildSettingsDescriptor(targetPath = resolveConfigPath()) {
  return {
    title: 'VK Orchestrator 設定',
    note: '保存後、orchestrator を再起動すると反映されます（vkTerminals 側の項目は次回 up/apply で反映）。',
    targetPath,
    groups: [
      {
        label: 'GitHub',
        note: 'GitHub トークンは `gh auth login` で管理します（このパネルでの入力は廃止）。',
        fields: [
          { key: 'github.owner',      label: 'タスク登録リポジトリのオーナー', type: 'text', help: 'task-queue の Issue を登録・管理するリポジトリのオーナー名（ユーザー名または組織名。例: vektor-inc）' },
          { key: 'github.repo',       label: 'タスク登録リポジトリ名',       type: 'text', help: 'task-queue の Issue を登録・管理するリポジトリ名（例: task-queue）' },
          { key: 'github.sourceOrg',  label: '作業対象リポジトリのオーナー（組織・省略可）', type: 'text', help: '作業対象リポジトリが属する組織名。この組織を横断検索して `task-queue` ラベル付き Issue を取り込む。未指定時はタスク登録リポジトリのオーナーと同じ組織を対象にする', emptyToNull: true },
          { key: 'github.queueLabel', label: '取り込みラベル名',           type: 'text', help: '作業対象リポジトリの Issue にこのラベルが付いていると、オーケストレーターのタスクとして取り込みます' },
        ],
      },
      {
        label: 'オーケストレーター',
        fields: [
          { key: 'orchestrator.pollIntervalMs',  label: 'ポーリング間隔 (ms)',  type: 'number', help: 'GitHub をポーリングして新しいタスクを確認する間隔（ミリ秒。例: 60000 = 1 分）' },
          { key: 'orchestrator.watchdogIdleMs',  label: 'ウォッチドッグ idle (ms)', type: 'number', help: 'この時間ターミナルが無活動だと停滞とみなす閾値（ミリ秒。例: 10800000 = 3 時間）' },
          { key: 'orchestrator.paneResumeMax',   label: 'ペイン消失時の自動再開上限 (回)', type: 'number', help: '作業ペイン消失時（PR 未生成に限る）に自動で再実行する上限回数。超えると failed になり手動確認が必要（既定: 3）' },
          { key: 'orchestrator.assigneeFilter',  label: '担当者フィルタ (login)', type: 'text', help: 'この GitHub ログイン名が assign されている Issue だけを取り込む。空＝一切取り込まない（安全側の既定）。全件取り込むには all と入力', emptyToNull: true },
          { key: 'orchestrator.taskCwd',         label: 'タスク用ペインの Claude Code 起点ディレクトリ', type: 'text', help: 'タスク着手時に開くペインの Claude Code の起点ディレクトリを指定してください。自分のリポジトリ置き場を指定しておくと、探索・クローンがそこ基準で進みます。未設定の場合は専用ディレクトリ ~/vk-orchestrator-tasks（自動作成）で起動し、ホームディレクトリや機密ディレクトリを起点にしません。なお、ここで指定するのはあくまで起点で、操作権限があれば他のディレクトリのファイルも操作できます。別のディレクトリにある既存リポジトリを扱いたい場合も、スキルや Claude のグローバル設定であらかじめ対象リポジトリを指定しておけば、そちらで作業します。相対パスは orchestrator 起動時の作業ディレクトリ基準で解決します。', emptyToNull: true },
        ],
      },
      {
        label: 'VK Terminals',
        fields: [
          { key: 'vkTerminals.port',            label: 'API ポート',          type: 'number', help: 'VK Terminals の API サーバーが待ち受けるポート番号（既定: 13847）' },
          { key: 'vkTerminals.host',            label: 'API ホスト',          type: 'text', help: 'VK Terminals の API サーバーのホスト（既定: 127.0.0.1）' },
          { key: 'vkTerminals.gpu',             label: 'GPU モード',          type: 'select',
            options: [
              { value: '',         label: '自動（推奨・macOS は通常起動 / その他は off）' },
              { value: 'off',      label: 'off（GPU 無効・エラーログ抑制）' },
              { value: 'default',  label: 'default（Chromium 任せ）' },
            ],
            help: 'GUI(Electron) の GPU 利用モード（次回 up で反映）。空=自動（macOS は通常起動 / その他は off）、off=GPU 無効でエラーログ抑制、default=Chromium 任せ' },
          { key: 'vkTerminals.initialCommand',  label: '初期コマンド',        type: 'text', help: '各ペイン起動時に自動実行するコマンド（次回 up/apply で反映）' },
          { key: 'vkTerminals.additionalPanes', label: '追加ペイン (JSON 配列)', type: 'json', help: '起動時に追加で開くペインの定義（JSON 配列。例: [{"cwd":"/path"}]）' },
        ],
      },
      {
        label: 'issue を処理する Claude のコマンド',
        fields: [
          { key: 'task.commandTemplate', label: 'コマンドテンプレート', type: 'text', placeholder: '/vk-kore {issueUrl} wp-env-port={wpPort} headless=1', help: 'issue に対して仕様検討・実装・プルリク作成・レビューまで自動で処理してマージできる状態にする Claude のコマンドを指定してください。未指定の場合は /vk-kore {issueUrl} wp-env-port={wpPort} headless=1 のような形式で投げられます。{issueUrl} と {wpPort} は自動で置換します。独自のコマンドを使用する場合、オーケストレーターと円滑に連携するための決め事がいくつかあります。詳しくは docs/agent-rules.md をご確認ください。デフォルトの /vk-kore スキルは vendor/vk-agents-public/skills/vk-kore/ にありますので、必要に応じてそれを参考に独自のスキルをご利用の PC の .claude に作ってください。' },
        ],
      },
      {
        label: 'vk-agents（エージェント共通設定）',
        fields: [
          { key: 'features.coderabbit', label: 'CodeRabbit 監視を有効化', type: 'boolean', default: true, help: 'OFF で PR 後の CodeRabbit 監視をスキップし、/code-review 等での確認を案内します。社外・個人リポジトリなど CodeRabbit 未導入の環境では OFF 推奨です' },
          { key: 'features.coderabbit_ignore', label: 'CodeRabbit レビューをスキップ（PR 本文に @coderabbitai ignore を記載）', type: 'boolean', default: false, help: 'ON で /vk-pr が PR 本文に @coderabbitai ignore を記載し、CodeRabbit レビューを抑止します。features.coderabbit が OFF のときは監視自体がスキップされるため、この設定は効果がありません' },
          { key: 'org.review_assets_repo', label: 'レビュー用アセットリポジトリ', type: 'text', placeholder: 'owner/repo', pattern: OWNER_REPO_PATTERN, invalidMessage: 'owner/repo の形式で入力してください（例: vektor-inc/task-queue）', help: 'PR・テスト報告用の画像/GIF を保存するリポジトリを <owner>/<repo> 形式で指定します（例: vektor-inc/review-assets）。形式が正しくない値は反映されません。空欄時は画像アップロードをスキップし、テキスト記述にフォールバックします', emptyToNull: true },
          { key: 'org.orchestrator_repo', label: '連携ルール取得先リポジトリ', type: 'text', placeholder: 'owner/repo', pattern: OWNER_REPO_PATTERN, invalidMessage: 'owner/repo の形式で入力してください（例: vektor-inc/task-queue）', help: 'vk-kore が task-queue 連携ルール（docs/agent-rules.md）を取得するリポジトリを <owner>/<repo> 形式で指定します（例: vektor-inc/vk-orchestrator）。形式が正しくない値は反映されません。空欄時は vektor-inc/vk-orchestrator にフォールバックします', emptyToNull: true },
          { key: 'staff_wp_dev.engine', label: 'staff-wp-dev（和田）の実行エンジン', type: 'select',
            options: [
              { value: '',       label: '未設定（既定: claude）' },
              { value: 'claude', label: 'claude' },
              { value: 'codex',  label: 'codex（単独作業のみ・push/PR は司が担当）' },
            ],
            help: 'staff-wp-dev（和田）を起動するときの実行エンジン。未設定時は claude にフォールバックします' },
          { key: 'multi_repo_task.default_engine', label: 'vk-multi-repo-task の既定実行エンジン', type: 'select',
            options: [
              { value: '',       label: '未設定（既定: claude）' },
              { value: 'claude', label: 'claude' },
              { value: 'codex',  label: 'codex' },
            ],
            help: 'マルチリポジトリタスク（vk-multi-repo-task）を新規作成するときの既定エンジン。未設定時は claude にフォールバックします' },
        ],
      },
    ],
  };
}

/**
 * 設定ディスクリプタを VK Terminals のインストールディレクトリへ書き出す。
 * up 実行時にここへ書き出し、env VK_TERMINALS_SETTINGS でパスを GUI へ渡す。
 * @param {string} [vkDir] VK Terminals のインストールディレクトリ
 * @param {string} [targetPath] 編集対象の config.json パス
 * @returns {string} 書き出したディスクリプタのパス
 */
export function writeSettingsDescriptor(vkDir = resolveVkTerminalsDir(), targetPath = resolveConfigPath()) {
  const descPath = join(vkDir, 'settings-descriptor.json');
  writeFileSync(descPath, JSON.stringify(buildSettingsDescriptor(targetPath), null, 2) + '\n');
  return descPath;
}

/**
 * 環境変数のブール値を解釈する。
 * `'false'` / `'0'`（大文字小文字・前後空白は無視）を false、それ以外の非空値を true とみなす。
 * 未定義・空文字は「未指定」として undefined を返す（呼び出し側で上書きをスキップする）。
 * @param {string|undefined} raw 環境変数の生値
 * @returns {boolean|undefined}
 */
function parseEnvBool(raw) {
  // trim 後に空なら「未指定」。空白のみの値も未指定として扱う（true に倒さない）。
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '') return undefined;
  return !(v === 'false' || v === '0');
}

/**
 * task セクションの解決済み設定を返す。
 * 優先順位: 環境変数 > config.json(cfg.task) > DEFAULT_TASK。
 * config.json は既定値へ再帰的にディープマージし、未指定キーは既定にフォールバックする。
 * env はスカラ値のみを上書きする（この repo の idiom に合わせ env 名を明示）。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_TASK}
 */
export function getTaskConfig(cfg = loadUnifiedConfig()) {
  // 空値（GUI 保存由来の "" / null / [] 等）は除去してから既定へマージ（空で既定を潰さない）。
  const merged = deepMerge(DEFAULT_TASK, pruneEmpty(cfg?.task) ?? {});
  // 環境変数レイヤー（env > config.json）。空文字・未定義は無視（applyConfigToEnv の set と同じ扱い）。
  const env = process.env;
  if (env.TASK_COMMAND_TEMPLATE) merged.commandTemplate = env.TASK_COMMAND_TEMPLATE;
  if (env.TASK_WP_PORT_BASE)     merged.portBase = Number(env.TASK_WP_PORT_BASE);
  if (env.TASK_WP_PORT_STRIDE)   merged.portStride = Number(env.TASK_WP_PORT_STRIDE);
  // wpEnv.enabled の env 上書き。空文字・未定義は無視（parseEnvBool が
  // undefined を返す）。'false' / '0' を false 扱いにし、それ以外の非空値は true とみなす。
  const wpEnvEnabled = parseEnvBool(env.TASK_WP_ENV_ENABLED);
  if (wpEnvEnabled !== undefined) {
    merged.wpEnv = { ...merged.wpEnv, enabled: wpEnvEnabled }; // ネスト構造を保つ
  }
  return merged;
}

/**
 * タスク用ペイン（Claude Code）の起点ディレクトリを返す。
 * 優先順位: 環境変数 TASK_CWD > config.json(cfg.orchestrator.taskCwd) > 専用ディレクトリ。
 * 未設定時は `~/vk-orchestrator-tasks` を使う。これは $HOME 直下や特定リポジトリ、
 * config.json / .env 等の機密ディレクトリを起点にせず、空・非 git の専用ディレクトリから
 * タスクを始めるための安全側の既定。ただし cwd は隔離ではなく、絶対パス指定での
 * ファイル読み取りを防ぐものではない。
 * env / config の明示値は前後空白を除去し、空文字なら未指定として次の優先順位へ
 * フォールバックする。相対パスが指定された場合は process.cwd() 基準で resolve() される。
 * 既定ディレクトリは VK Terminals 側フォールバックで $HOME 起点にならないよう自動作成する。
 * 一方、明示値は typo を隠さないため自動作成せず、存在しない場合は警告だけ出して返す。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @param {string} [homeDir] 既定ディレクトリの親となるホームディレクトリ
 * @returns {string}
 */
export function getTaskCwd(cfg = loadUnifiedConfig(), homeDir = homedir()) {
  const envValue = String(process.env.TASK_CWD ?? '').trim();
  if (envValue !== '') return resolveExplicitTaskCwd(envValue);

  const configValue = String(cfg?.orchestrator?.taskCwd ?? '').trim();
  if (configValue !== '') return resolveExplicitTaskCwd(configValue);

  const defaultDir = join(homeDir, 'vk-orchestrator-tasks');
  try {
    mkdirSync(defaultDir, { recursive: true });
  } catch {
    // 既に存在する / 作成に失敗した場合でも起点としては返す。
  }
  return defaultDir;
}

const warnedMissingTaskCwds = new Set();

function resolveExplicitTaskCwd(rawValue) {
  const taskCwd = resolve(rawValue);
  if (!existsSync(taskCwd) && !warnedMissingTaskCwds.has(taskCwd)) {
    warnedMissingTaskCwds.add(taskCwd);
    console.warn(`[Config] 指定された taskCwd が存在しません。存在しないと VK Terminals 側フォールバックで $HOME 起点になる恐れがあります: ${taskCwd}`);
  }
  return taskCwd;
}

/**
 * protocol セクションの解決済み設定を返す。
 * 優先順位: config.json(cfg.protocol) > DEFAULT_PROTOCOL（現時点では env レイヤー無し）。
 * 個別フィールドの env 上書きは、実際に消費する後続 sub-issue で必要になった時に追加する。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_PROTOCOL}
 */
export function getProtocolConfig(cfg = loadUnifiedConfig()) {
  return deepMerge(DEFAULT_PROTOCOL, pruneEmpty(cfg?.protocol) ?? {});
}

/**
 * labels セクションの解決済み設定を返す。
 * 優先順位: config.json(cfg.labels) > DEFAULT_LABELS（現時点では env レイヤー無し）。
 * 個別フィールドの env 上書きは、実際に消費する後続 sub-issue で必要になった時に追加する。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_LABELS}
 */
export function getLabelsConfig(cfg = loadUnifiedConfig()) {
  return deepMerge(DEFAULT_LABELS, pruneEmpty(cfg?.labels) ?? {});
}

/**
 * gh CLI の認証済みトークンを取得する。トークン値は呼び出し側でログ出力しないこと。
 * @param {(file: string, args: string[], options: object) => string|Buffer} [execFileSyncImpl]
 * @returns {string}
 */
export function getGitHubTokenFromGh(execFileSyncImpl = execFileSync) {
  return String(execFileSyncImpl('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })).trim();
}

/**
 * GITHUB_TOKEN が未設定なら gh auth token から取得して process.env に反映する。
 * 優先順位は、呼び出し前に dotenv / applyConfigToEnv 済みであることを前提に
 * 環境変数 > .env > config.json > gh auth token となる。
 * @param {{ execFileSync?: (file: string, args: string[], options: object) => string|Buffer }} [options]
 * @returns {string|undefined} 解決できた GITHUB_TOKEN
 */
export function ensureGitHubToken(options = {}) {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  try {
    const token = getGitHubTokenFromGh(options.execFileSync ?? execFileSync);
    if (token) {
      process.env.GITHUB_TOKEN = token;
      return token;
    }
  } catch {
    // 後段の必須チェックで gh auth login への誘導を出す。
  }
  return process.env.GITHUB_TOKEN;
}

/**
 * env(＋事前に applyConfigToEnv 済みの config.json)から、オーケストレーターの
 * 構造化ランタイム設定を解決する。GITHUB_TOKEN 未設定なら gh auth token を試し、
 * それでも解決できなければ例外。
 * @param {string[]} [argv]
 * @param {{ execFileSync?: (file: string, args: string[], options: object) => string|Buffer }} [options]
 */
export function loadConfig(argv = process.argv, options = {}) {
  ensureGitHubToken(options);

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
    throw new Error(`[Config] ${GITHUB_TOKEN_RESOLUTION_HELP}`);
  }
  return cfg;
}
