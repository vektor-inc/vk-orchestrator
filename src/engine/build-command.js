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

import { getTaskConfig } from '../config.js';

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
// ターミナルID → wp-env ポート割り当て（8888/8889 は禁止）
// terminal 1 → portBase、terminal 2 → portBase+portStride …（testsPort は vk-kore 側で +1 する）
// 基準値・間隔は task 設定（portBase / portStride）から取得する。config 未設定時は
// 既定値（portBase=9100 / portStride=2）となり現行と同一のポート値になる。
// -------------------------------------------------------
export function assignWpEnvPort(termId, taskConfig = getTaskConfig()) {
  return taskConfig.portBase + (Number(termId) - 1) * taskConfig.portStride;
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
export function buildCommand(title, body, termId, taskConfig = getTaskConfig(), wpEnvEnabled) {
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
    const wpPort = enabled ? assignWpEnvPort(termId, taskConfig) : null;
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
