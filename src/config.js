// 設定の一元化。
//
// VK Orchestrator は「単一の設定ファイル(config.json)」を正とし、そこから
//   1) 自分自身(オーケストレーター)のランタイム設定
//   2) VK Terminals 用の設定ファイル(VK Terminals のインストールディレクトリ内 config.json)
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
  // wp-env 連携の ON/OFF。既定は true（現行どおりポート割り当て・{wpPort} 展開・
  // マージ後クリーンアップを行う）。false にすると wp-env 関連（ポート割り当て・
  // state.json への wpPort 保存・クリーンアップ）を一切行わず、{wpPort} を含まない
  // テンプレートに差し替えることで vk-kore 以外の任意スキル／素のプロンプトを起動できる。
  wpEnv: { enabled: true },
  // automerge の e2e 完了ゲートを使うか。既定 true=現行どおりマーカー必須。
  // false でマーカー無しでも automerge が進む（CI/CodeRabbit ゲートは維持）。
  requireE2eGate: true,
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
 * e2e 完了マーカー（ラベル名・SHA 接頭辞）は config 化せず、src/github/index.js の
 * 固定定数（E2E_PASSED_LABEL / E2E_PASSED_SHA_PREFIX）のまま運用する。
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
  set('PANE_RESUME_MAX', o.paneResumeMax);
  set('ASSIGNEE_FILTER', o.assigneeFilter);

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
        fields: [
          { key: 'github.token',      label: 'Personal Access Token', type: 'password', help: 'GitHub API へアクセスするための個人アクセストークン（repo スコープが必要）', emptyToNull: true },
          { key: 'github.owner',      label: 'Owner',                 type: 'text', help: '監視対象リポジトリのオーナー名（ユーザー名または組織名。例: vektor-inc）' },
          { key: 'github.repo',       label: 'Repo',                  type: 'text', help: 'オーケストレーターが監視する対象のリポジトリ名（例: task-queue）' },
          { key: 'github.sourceOrg',  label: 'Source Org',            type: 'text', help: 'タスクを取り込む対象の組織名（未指定時は Owner と同じ）' },
          { key: 'github.queueLabel', label: 'Queue Label',           type: 'text', help: 'このラベル名が付与されている Issue をオーケストレーターのタスクとして取みます' },
        ],
      },
      {
        label: 'オーケストレーター',
        fields: [
          { key: 'orchestrator.pollIntervalMs',  label: 'ポーリング間隔 (ms)',  type: 'number', help: 'GitHub をポーリングして新しいタスクを確認する間隔（ミリ秒。例: 60000 = 1 分）' },
          { key: 'orchestrator.watchdogIdleMs',  label: 'ウォッチドッグ idle (ms)', type: 'number', help: 'この時間ターミナルが無活動だと停滞とみなす閾値（ミリ秒。例: 10800000 = 3 時間）' },
          { key: 'orchestrator.paneResumeMax',   label: 'ペイン消失時の自動再開上限 (回)', type: 'number', help: '作業ペイン消失時（PR 未生成に限る）に自動で再実行する上限回数。超えると failed になり手動確認が必要（既定: 3）' },
          { key: 'orchestrator.assigneeFilter',  label: '担当者フィルタ (login)', type: 'text', help: 'この GitHub ログイン名が assign されている Issue だけを取り込む（空で無効＝全件対象）', emptyToNull: true },
        ],
      },
      {
        label: 'VK Terminals',
        fields: [
          { key: 'vkTerminals.port',            label: 'API ポート',          type: 'number', help: 'VK Terminals の API サーバーが待ち受けるポート番号（既定: 13847）' },
          { key: 'vkTerminals.host',            label: 'API ホスト',          type: 'text', help: 'VK Terminals の API サーバーのホスト（既定: 127.0.0.1）' },
          { key: 'vkTerminals.initialCommand',  label: '初期コマンド',        type: 'text', help: '各ペイン起動時に自動実行するコマンド（次回 up/apply で反映）' },
          { key: 'vkTerminals.agentroom',       label: 'エージェントルーム表示', type: 'boolean', help: 'エージェントルームのペインを表示するか（次回 up/apply で反映）' },
          { key: 'vkTerminals.additionalPanes', label: '追加ペイン (JSON 配列)', type: 'json', help: '起動時に追加で開くペインの定義（JSON 配列。例: [{"cwd":"/path"}]）' },
        ],
      },
      {
        label: 'タスク',
        fields: [
          { key: 'task.commandTemplate', label: 'コマンドテンプレート', type: 'text', help: 'タスク着手時に各ペインへ投入するコマンド。{issueUrl} と {wpPort} は自動で置換（既定: /vk-kore {issueUrl} wp-env-port={wpPort} headless=1）' },
          { key: 'task.wpEnv.enabled', label: 'wp-env 連携を有効化', type: 'boolean', help: 'ON でタスク着手時に wp-env ポート割り当て・{wpPort} 展開・マージ後クリーンアップを行う（既定）。OFF にすると wp-env 関連を一切行わず、{wpPort} を含まないテンプレートに差し替えて vk-kore 以外のスキルや素のプロンプトを起動できる。無人実行を維持する場合はテンプレートに headless=1 を含める' },
          { key: 'task.requireE2eGate', label: 'automerge の e2e ゲートを必須化', type: 'boolean', help: 'ON で automerge 時に e2e 完了マーカーを必須にする（既定）。OFF にすると e2e を回さないプロジェクトでもマーカー無しで automerge が進む（CI/CodeRabbit ゲートは維持）' },
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
 * task セクションの解決済み設定を返す。
 * 優先順位: 環境変数 > config.json(cfg.task) > DEFAULT_TASK。
 * config.json は既定値へ再帰的にディープマージし、未指定キーは既定にフォールバックする。
 * env はスカラ値のみを上書きする（この repo の idiom に合わせ env 名を明示）。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_TASK}
 */
export function getTaskConfig(cfg = loadUnifiedConfig()) {
  const merged = deepMerge(DEFAULT_TASK, cfg?.task ?? {});
  // 環境変数レイヤー（env > config.json）。空文字・未定義は無視（applyConfigToEnv の set と同じ扱い）。
  const env = process.env;
  if (env.TASK_COMMAND_TEMPLATE) merged.commandTemplate = env.TASK_COMMAND_TEMPLATE;
  if (env.TASK_WP_PORT_BASE)     merged.portBase = Number(env.TASK_WP_PORT_BASE);
  if (env.TASK_WP_PORT_STRIDE)   merged.portStride = Number(env.TASK_WP_PORT_STRIDE);
  // wpEnv.enabled の env 上書き。空文字・未定義は無視（他の env 上書きと同じ扱い）。
  // 'false' / '0' を false 扱いにし、それ以外の非空値は true とみなす（ネスト構造を保つ）。
  if (env.TASK_WP_ENV_ENABLED) {
    const v = env.TASK_WP_ENV_ENABLED.trim().toLowerCase();
    merged.wpEnv = { ...merged.wpEnv, enabled: !(v === 'false' || v === '0') };
  }
  // requireE2eGate の env 上書き。空文字・未定義は無視（TASK_WP_ENV_ENABLED と同じ扱い）。
  // 'false' / '0' を false 扱いにし、それ以外の非空値は true とみなす。
  if (env.TASK_REQUIRE_E2E_GATE) {
    const v = env.TASK_REQUIRE_E2E_GATE.trim().toLowerCase();
    merged.requireE2eGate = !(v === 'false' || v === '0');
  }
  return merged;
}

/**
 * protocol セクションの解決済み設定を返す。
 * 優先順位: config.json(cfg.protocol) > DEFAULT_PROTOCOL（現時点では env レイヤー無し）。
 * 個別フィールドの env 上書きは、実際に消費する後続 sub-issue で必要になった時に追加する。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_PROTOCOL}
 */
export function getProtocolConfig(cfg = loadUnifiedConfig()) {
  return deepMerge(DEFAULT_PROTOCOL, cfg?.protocol ?? {});
}

/**
 * labels セクションの解決済み設定を返す。
 * 優先順位: config.json(cfg.labels) > DEFAULT_LABELS（現時点では env レイヤー無し）。
 * 個別フィールドの env 上書きは、実際に消費する後続 sub-issue で必要になった時に追加する。
 * @param {object} [cfg] loadUnifiedConfig() の戻り値
 * @returns {typeof DEFAULT_LABELS}
 */
export function getLabelsConfig(cfg = loadUnifiedConfig()) {
  return deepMerge(DEFAULT_LABELS, cfg?.labels ?? {});
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
