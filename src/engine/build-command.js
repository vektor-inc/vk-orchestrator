// -------------------------------------------------------
// タスク着手時にペインへ投入するコマンド（プロンプト）の組み立てと、
// wp-env ポート割り当て・テンプレート展開の純粋関数群。
//
// engine/index.js は import しただけで orchestrator 本体を自走させる（副作用実行）ため、
// テストから安全に import できるよう、副作用の無いこれらの関数はこのモジュールへ分離する。
// engine/index.js からは import して利用しつつ再 export もするので、index.js からも参照できる。
//
// いずれの関数も taskConfig を DI 可能にしており（既定は getTaskConfig()）、
// config.json / 環境変数に依存せずユニットテストできる。
// -------------------------------------------------------

import net from 'node:net';

import { getTaskConfig } from '../config.js';

const DEFAULT_PORT_PROBE_HOST = '127.0.0.1';
export const DEFAULT_WP_ENV_PORT_SCAN_LIMIT = 128;
const RESERVED_WP_ENV_PORTS = new Set([8888, 8889]);

// -------------------------------------------------------
// 表示不能な制御文字の除去（多層防御用の純粋ヘルパー）。
//
// 除去対象は C0(\x00-\x1f)・DEL(\x7f)・C1(\x80-\x9f)。これらがタイトル文字列に
// 混じると、OSC 0 でペインタイトルを送る際にシーケンスを途中で壊したり、8bit C1 を
// OSC/ST として解釈する端末でブレイクアウトを許してしまう。外部由来（GitHub issue
// タイトル等）の文字列を扱うため、送信前に一段落として正規化する。
//
// terminals/index.js の buildPaneTitleSequence と同一の正規表現を共有し、除去ロジックを
// 2 箇所に複製しないための単一の出所とする（DRY）。
//
// @param {string} str 正規化したい文字列（文字列以外は String() 化する）
// @returns {string} 制御文字を除去した文字列
// -------------------------------------------------------
export function stripControlChars(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

// -------------------------------------------------------
// GitHub issue URL の抽出
// -------------------------------------------------------
export function extractGitHubIssueUrl(text) {
  if (!text) return null;
  const match = text.match(
    /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/
  );
  if (!match) return null;
  return { url: match[0], owner: match[1], repo: match[2], number: Number(match[3]) };
}

// -------------------------------------------------------
// ペインヘッダーに表示するタイトル・リンクの組み立て。
//
// task-queue に複製したメタ issue ではなく、元の作業対象リポジトリの issue の
// タイトル・リンクを表示するための純粋関数（issue #23）。
// - metaIssue:      タスク登録リポジトリ側のメタ issue（`{ number, title, html_url }`）
// - resolvedTarget: 元の作業対象 issue が解決できたときのみ `{ number, title, url }`。
//                   解決できない汎用タスクや取得失敗時は null を渡す。
// resolvedTarget があればそれを、無ければ従来どおりメタ issue を表示対象にする。
// @returns {{ titleText: string, url: string }}
// -------------------------------------------------------
export function buildPaneTitle(metaIssue, resolvedTarget) {
  // titleText は外部由来（issue タイトル）を含むため制御文字を除去して正規化する
  // （多層防御。URL 側は github.com 由来でスキーム検証済みのため触らない）。
  if (resolvedTarget) {
    return {
      titleText: stripControlChars(`#${resolvedTarget.number} ${resolvedTarget.title}`),
      url: resolvedTarget.url,
    };
  }
  return {
    titleText: stripControlChars(`#${metaIssue.number} ${metaIssue.title}`),
    url: metaIssue.html_url,
  };
}

// -------------------------------------------------------
// 実 OS レベルのポート空き確認。テストでは assignWpEnvPort の options.isPortAvailable で
// スタブを注入し、この関数へ到達しないようにする。
// probe 後から wp-env 起動までの間に他プロセスへポートを奪われる TOCTOU は原理的に残る。
// その場合は wp-env 自身の起動失敗として顕在化させ、ここでは事前スクリーニングに徹する。
// -------------------------------------------------------
export function isPortAvailable(port, host = DEFAULT_PORT_PROBE_HOST) {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (available) => {
      if (settled) return;
      settled = true;
      resolve(available);
    };

    server.once('error', () => done(false));
    server.once('listening', () => {
      server.close(() => done(true));
    });
    try {
      server.listen(port, host);
    } catch {
      done(false);
    }
  });
}

function normalizePortSet(ports = []) {
  const normalized = new Set();
  for (const port of ports ?? []) {
    const n = Number(port);
    if (Number.isInteger(n) && n > 0) normalized.add(n);
  }
  return normalized;
}

function isReservedPair(port, reservedPorts) {
  return (
    RESERVED_WP_ENV_PORTS.has(port) ||
    RESERVED_WP_ENV_PORTS.has(port + 1) ||
    reservedPorts.has(port) ||
    reservedPorts.has(port + 1)
  );
}

// state.json の issue レコード群から、他アクティブタスクが確保済みの wp-env ポート集合を作る。
// wp-env は wpPort と testsPort(wpPort+1) のペアを使うため、両方を予約済みに含める。
// 現在起動しようとしている issue 自身の古いレコードは除外し、再開時の自己衝突を避ける。
// -------------------------------------------------------
export function collectReservedWpEnvPorts(taskRecords = {}, currentIssueNumber = null) {
  const reserved = new Set();
  const currentKey = currentIssueNumber == null ? null : String(currentIssueNumber);

  for (const [issueNumber, record] of Object.entries(taskRecords ?? {})) {
    if (currentKey !== null && String(issueNumber) === currentKey) continue;
    const wpPort = Number(record?.wpPort);
    if (!Number.isInteger(wpPort) || wpPort <= 0) continue;
    reserved.add(wpPort);
    reserved.add(wpPort + 1);
  }

  return reserved;
}

// ターミナルID → wp-env ポート割り当て（8888/8889 は禁止）
// terminal 1 → portBase、terminal 2 → portBase+portStride …を探索起点にし、
// 起点から portStride 刻みで wpPort/testsPort の空きペアを前方走査する。
// 起点ペアが空いていれば従来どおり同一ポートを返す（後方互換）。
// -------------------------------------------------------
export async function assignWpEnvPort(termId, taskConfig = getTaskConfig(), options = {}) {
  const base = Number(taskConfig.portBase);
  const stride = Number(taskConfig.portStride);
  const term = Number(termId);
  if (!Number.isInteger(base) || base <= 0 || !Number.isInteger(stride) || stride <= 0 || !Number.isInteger(term) || term <= 0) {
    throw new Error(`wp-env ポート割り当て設定が不正です (termId=${termId}, portBase=${taskConfig.portBase}, portStride=${taskConfig.portStride})`);
  }

  const startPort = base + (term - 1) * stride;
  const maxScanAttempts = options.maxScanAttempts ?? DEFAULT_WP_ENV_PORT_SCAN_LIMIT;
  if (!Number.isInteger(maxScanAttempts) || maxScanAttempts <= 0) {
    throw new Error(`wp-env ポート探索上限が不正です (maxScanAttempts=${maxScanAttempts})`);
  }

  const probe = options.isPortAvailable ?? isPortAvailable;
  const host = options.host ?? DEFAULT_PORT_PROBE_HOST;
  const reservedPorts = normalizePortSet(options.reservedPorts);

  for (let attempt = 0; attempt < maxScanAttempts; attempt += 1) {
    const port = startPort + attempt * stride;
    if (isReservedPair(port, reservedPorts)) continue;

    const [wpAvailable, testsAvailable] = await Promise.all([
      probe(port, host),
      probe(port + 1, host),
    ]);
    if (wpAvailable && testsAvailable) return port;
  }

  const lastPort = startPort + (maxScanAttempts - 1) * stride;
  throw new Error(
    `wp-env の空きポートペアが見つかりません (start=${startPort}, last=${lastPort}, stride=${stride}, attempts=${maxScanAttempts})`
  );
}

// -------------------------------------------------------
// コマンドテンプレートのプレースホルダ展開。
// `{issueUrl}` / `{wpPort}` などの `{name}` を vars[name] で置換する。
// - vars に値がある（null/undefined でない）キーだけを置換する。
// - 未知プレースホルダ・値が無い（null/undefined）プレースホルダは元の文字列
//   （例 `{wpPort}`）のまま残す（例外を投げない）。これにより wp-env 無効時に
//   wpPort が null でも展開が壊れない。
// -------------------------------------------------------
export function expandTemplate(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, key) => {
    const val = vars[key];
    if (val === undefined || val === null) return match;
    return String(val);
  });
}

// -------------------------------------------------------
// Claudeへの送信コマンドを組み立てる。
// 戻り値には wpPort も含め、呼び出し側（recordTaskStart）が再計算・再読み込みせずに
// 同じ値を使い回せるようにする（二重計算・二重 config 読み込みの回避）。
// -------------------------------------------------------
export async function buildCommand(title, body, termId, taskConfig = getTaskConfig(), wpEnvEnabled, portOptions = {}) {
  const fullText = [title, body].filter(Boolean).join('\n\n');
  const targetIssue = extractGitHubIssueUrl(fullText);
  // wp-env 連携が有効か。呼び出し側（startTask）が対象リポの `.wp-env.json` 有無から
  // 解決した boolean を第5引数で渡す。無効のときはポート割り当て・{wpPort} 展開・
  // クリーンアップ用の wpPort 保存をすべて行わない。
  // 未指定（ユニットテスト等で第5引数を省略）のときは taskConfig.wpEnv.enabled で判定する
  // （null/undefined = 自動扱いで有効、明示 false のみ無効）— 後方互換のためのフォールバック。
  const enabled = typeof wpEnvEnabled === 'boolean'
    ? wpEnvEnabled
    : (taskConfig.wpEnv?.enabled !== false);

  if (targetIssue) {
    // wp-env 有効時のみポートを割り当てる。無効時は null（state に保存されず、
    // 既存の runPostMergeCleanup / snapshotWorktreePath が !saved.wpPort で早期 return）。
    const wpPort = enabled ? await assignWpEnvPort(termId, taskConfig, portOptions) : null;
    console.log(`  → GitHub issue URLを検出: ${targetIssue.url} → コマンドテンプレートを使用`);
    if (wpPort != null) {
      console.log(`  → wp-env ポート割り当て: ${wpPort} (testsPort=${wpPort + 1})`);
    } else {
      console.log(`  → wp-env 無効（.wp-env.json 未検出 / 設定で false）: ポート割り当てをスキップ`);
    }

    // コマンドテンプレートを展開する。既定テンプレートは
    // `/vk-kore {issueUrl} wp-env-port={wpPort} headless=1` になる。
    // wpPort が null（wp-env 無効）でも、{wpPort} を含まないテンプレートなら壊れない。
    const prompt = expandTemplate(taskConfig.commandTemplate, {
      issueUrl: targetIssue.url,
      wpPort,
    });
    return { prompt, targetIssue, wpPort };
  }

  // 汎用タスク（GitHub issue URL なし）: テンプレートは使わず title + body をそのまま送る。
  let prompt = title;
  if (body && body.trim()) prompt += `\n\n${body.trim()}`;
  return { prompt, targetIssue: null, wpPort: null };
}
