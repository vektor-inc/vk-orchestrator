// -------------------------------------------------------
// 秘匿情報マスキング（純粋関数・issue #126 / CWE-200 対策）
//
// 指示待ちコメントの端末出力（lastLines）を公開リポジトリの issue / PR に貼る
// ようになったため（issue #126）、トークン・アクセスキー・秘密鍵などの秘匿情報が
// そのまま露出するリスクがある。本文に埋め込む直前にこの関数を通して伏字化する。
//
// 検出箇所は `***REDACTED***` に置換する。投稿先に関わらず一律で適用すること。
//
// 副作用を持たない純粋関数なので、tests/redactSecrets.test.js で単体テストできる。
// -------------------------------------------------------

const REDACTED = '***REDACTED***';

// マスク対象パターン。各パターンは「秘匿情報全体」にマッチさせ、まるごと REDACTED に置換する。
// 順序依存はないが、PEM ブロックのような複数行パターンは個別に dotAll で処理する。
const SECRET_PATTERNS = [
  // GitHub トークン（classic: ghp_/gho_/ghu_/ghs_/ghr_ ... fine-grained: github_pat_）
  /\bgh[poursa]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS アクセスキー ID（long-term: AKIA / temporary STS: ASIA）
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Authorization ヘッダ等の Bearer トークン（"Bearer " ごと置換して種別の痕跡も消す）
  /Bearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  // Slack トークン（xoxb- / xoxa- / xoxp- / xoxr- / xoxs-）
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

// PEM 秘密鍵ブロック（複数行）。BEGIN 〜 END までをまるごと潰す。
// END 行が欠けた途中までの出力（lastLines はターミナルの末尾断片なので起こりうる）でも
// BEGIN 以降を末尾まで潰せるよう、END が無い場合も後方をマスクする。
const PEM_WITH_END = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const PEM_WITHOUT_END = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g;

/**
 * テキスト中の秘匿情報を `***REDACTED***` に置換して返す純粋関数。
 *
 * @param {string} text  マスキング対象の文字列（端末の lastLines 等）
 * @returns {string}     秘匿情報を伏字化した文字列。null/undefined はそのまま返す。
 */
export function redactSecrets(text) {
  if (text == null) return text;

  let result = String(text);

  // 1. PEM 秘密鍵ブロックを先に潰す（END 付き → END 無しの順）。
  //    先に単一行パターンを掛けると鍵本文の Base64 を別パターンが部分マッチして
  //    ブロック構造を崩しうるので、複数行ブロックを最優先で処理する。
  result = result.replace(PEM_WITH_END, REDACTED);
  result = result.replace(PEM_WITHOUT_END, REDACTED);

  // 2. 単一トークン系パターン
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }

  return result;
}

export { REDACTED };
