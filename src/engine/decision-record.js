/**
 * decision-record コメントの解析（純粋関数）。
 *
 * vk-agents の `rules/decision-record.md` で定められたコメント書式を読み取る。
 *   - 1 行目: `Comment by vk-agents`（エージェントの自動コメント識別行）
 *   - 2 行目: `Status: waiting-input` / `Status: no-action` / `Status: answered`
 *
 * task-queue オーケストレーターは、
 *   - `Comment by vk-agents` かつ `Status: waiting-input` のコメント
 *     → ユーザー指示待ち（status:waiting-input）のシグナル
 *   - エージェント発でも bot 投稿でもない新規コメント
 *     → ユーザー返信（pane へ転送して in-progress に戻す）
 *   - `Comment by vk-agents` かつ `Status: answered` のコメント
 *     → 司がペイン経由で質問を解決済みと明示宣言したシグナル（GitHub 上には返信が
 *       付かないため）。転送不要で pending を解除し in-progress に戻す。エージェント発でも
 *       pending を解除する唯一の Status（他のエージェント発コメントでは解除しない）。
 * として消費する。
 *
 * 「ユーザー返信」の判定では bot 投稿（`user.type === 'Bot'`）を除外する。
 * 呼び出し側（gatherTargetState）は対象 issue と PR のコメントを合算するため、
 * PR がある限り CodeRabbit などの bot コメントが必ず混入する。これを返信扱いすると、
 *   - pane で作業中の Claude に無意味な入力を転送してしまう
 *   - 未応答の waiting-input を「応答済み」と誤判定して waiting-input に倒れない
 * という不具合になる（#141）。bot 判定は投稿者の種別で行い、本文の内容では行わない。
 *
 * GitHub API 依存を持たない純粋関数として切り出し、ユニットテスト可能にしている。
 * 呼び出し側（index.js）は octokit でコメント一覧を取得し、ここへ流し込む。
 */

// decision-record の自動コメント識別行（1 行目に必ず置かれる）。
export const AGENT_MARKER = 'Comment by vk-agents';

// 指示待ち（status:waiting-input）を表す Status トークン。
// task-queue のステータスラベル `status:waiting-input` と名前が一致する。
export const WAITING_INPUT_STATUS = 'waiting-input';

// `Status:` 行の許容トークン。
const STATUS_LINE_RE = /^Status:\s*(waiting-input|no-action|answered)$/;

/**
 * コメント本文 1 件を解析する。
 *
 * @param {string|null|undefined} body コメント本文
 * @returns {{ isAgentComment: boolean, status: ('waiting-input'|'no-action'|'answered'|null) }}
 *   - isAgentComment: 最初の非空行が `Comment by vk-agents`（前後空白許容）なら true
 *   - status: `Status:` 行（単独行）から読み取ったトークン。無ければ null
 *
 * 注意: `status` は識別行の有無に関わらず本文中の `Status:` 行から読む。
 *   「エージェントの waiting-input か」を判定したい場合は
 *   `isAgentComment && status === 'waiting-input'` で AND を取ること
 *   （ヘルパー `isWaitingInputByAgent` を用意している）。
 */
export function parseDecisionRecordComment(body) {
  const result = { isAgentComment: false, status: null };
  if (!body || typeof body !== 'string') return result;

  // GitHub の本文は CRLF を含みうるので正規化してから行単位で見る。
  const lines = body.replace(/\r\n/g, '\n').split('\n');

  // 識別行: 最初の「非空行」が AGENT_MARKER と一致するか。
  // （本文先頭に空行が紛れても識別できるよう、空行は読み飛ばす）
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    result.isAgentComment = trimmed === AGENT_MARKER;
    break;
  }

  // Status 行: 単独行で `Status: <token>` に一致する最初の行を採用する。
  // 文章中に `Status:` という語が出ても、単独行でなければ拾わない。
  for (const line of lines) {
    const m = line.trim().match(STATUS_LINE_RE);
    if (m) {
      result.status = m[1];
      break;
    }
  }

  return result;
}

/**
 * 「エージェントが投稿した waiting-input コメントか」を判定する便宜関数。
 *
 * @param {string|null|undefined} body
 * @returns {boolean}
 */
export function isWaitingInputByAgent(body) {
  const { isAgentComment, status } = parseDecisionRecordComment(body);
  return isAgentComment && status === WAITING_INPUT_STATUS;
}

/**
 * コメントが bot（GitHub App / bot アカウント）の投稿か判定する。
 *
 * coderabbitai[bot] や github-actions[bot] などは GitHub API 上
 * `user.type === 'Bot'` を返す。投稿者の種別だけで判定し、本文の内容では判定しない
 * （本文ヒューリスティックは正規のユーザー返信を誤って bot 扱いする恐れがあるため）。
 *
 * @param {{ user?: { type?: string } }|null|undefined} comment コメントオブジェクト
 * @returns {boolean}
 */
export function isBotComment(comment) {
  return comment?.user?.type === 'Bot';
}

/**
 * コメントが「ユーザー返信」か判定する。
 *
 * 返信 = エージェント発（識別行あり）でも bot 投稿でもないコメント。
 * 識別行の有無に加えて bot 投稿を除外することで、PR に混入する CodeRabbit などの
 * 自動コメントを返信と誤認しないようにする（モジュール冒頭の説明・#141 参照）。
 *
 * @param {{ body?: string, user?: { type?: string } }|null|undefined} comment
 * @returns {boolean}
 */
export function isUserReply(comment) {
  if (!comment || typeof comment !== 'object') return false;
  if (parseDecisionRecordComment(comment?.body).isAgentComment) return false;
  if (isBotComment(comment)) return false;
  return true;
}

/**
 * コメント配列から「ユーザー返信」を探す。
 *
 * 返信 = エージェント発（識別行あり）でも bot 投稿（`user.type === 'Bot'`）でもないコメント。
 * 求めていた返信でなければ vk-kore 側が再度 waiting-input を出して待ち直すため、
 * 内容の意味解釈はせず、識別行の有無と投稿者種別だけで機械的に判定する。
 *
 * @param {Array<{ body?: string, user?: { type?: string } }>} comments
 *   作成日時の昇順で渡す前提（呼び出し側で `since` などにより
 *   「waiting-input コメントより後」に絞り込んでおく）。
 * @returns {object|null} 最初に見つかったユーザー返信（渡された要素そのもの）。無ければ null
 */
export function findUserReply(comments) {
  if (!Array.isArray(comments)) return null;
  for (const c of comments) {
    if (isUserReply(c)) {
      return c;
    }
  }
  return null;
}

/**
 * コメント配列から最新の「エージェント発 waiting-input コメント」を返す。
 *
 * @param {Array<{ body?: string }>} comments 作成日時の昇順で渡す前提
 * @returns {object|null} 最後（最新）の waiting-input エージェントコメント。無ければ null
 */
export function findLatestWaitingInput(comments) {
  if (!Array.isArray(comments)) return null;
  let latest = null;
  for (const c of comments) {
    if (isWaitingInputByAgent(c?.body)) {
      latest = c;
    }
  }
  return latest;
}

/**
 * 「未応答の waiting-input があるか（＝指示待ちに倒すべきか）」を判定する。
 *
 * コメントを昇順に走査し、
 *   - エージェント発 waiting-input を観測 → pending を true
 *   - ユーザー返信（エージェント発でも bot 投稿でもないコメント）を観測 → pending を false
 *     （直近の確認は応答されたとみなす）
 *   - エージェント発 answered（司がペイン経由で解決を明示宣言）を観測 → pending を false
 *     （GitHub 上に返信は付かないが、司の明示宣言で解除する）
 *   - エージェント発 no-action は確認でも返信でもないので pending を変えない
 *   - bot コメント（CodeRabbit 等）は返信ではないので pending を変えない
 *     （ここを除外しないと「bot がコメントした＝応答済み」と誤判定して waiting-input に
 *      倒れない経路が残る。#141 参照）
 * 最終的な pending が、最後の「確認 or 返信 or 解決宣言」イベントが未応答の確認だったかを表す。
 * 確認→返信のサイクルが複数回起きても正しく追従する。
 *
 * 注意: エージェント発で pending を解除するのは `answered` だけ。「最後のコメントが
 * waiting-input でなければ解除」という推定はしない（waiting-input の後に無関係な
 * no-action 報告が割り込んでも誤って解除しない安全側設計）。answered は司の明示宣言なので
 * 追加で解除対象に加える、という位置づけ。
 *
 * @param {Array<{ body?: string, user?: { type?: string } }>} comments 作成日時の昇順で渡す前提
 * @returns {boolean}
 */
export function hasPendingWaitingInput(comments) {
  if (!Array.isArray(comments)) return false;
  let pending = false;
  for (const c of comments) {
    const { isAgentComment, status } = parseDecisionRecordComment(c?.body);
    if (isAgentComment) {
      if (status === WAITING_INPUT_STATUS) pending = true;
      else if (status === 'answered') pending = false; // 司がペイン経由で解決を明示宣言 → 解除
      // no-action は pending を変えない
    } else if (isUserReply(c)) {
      // 本物のユーザー返信のみが直近の確認を解除する。bot 投稿は pending を変えない。
      pending = false;
    }
  }
  return pending;
}

/**
 * 指示待ち中に pane へ転送すべきユーザー返信を返す。
 *
 * 直近のエージェント発 waiting-input コメントより後にある、最初の
 * 「ユーザー返信」（エージェント発でも bot 投稿でもないコメント）を返す。
 * bot 投稿を除外しないと CodeRabbit の自動コメントを pane へ転送してしまう（#141）。
 *
 * @param {Array<{ body?: string, user?: { type?: string } }>} comments 作成日時の昇順で渡す前提
 * @returns {object|null} 転送対象コメント（渡された要素そのもの）。無ければ null
 */
export function findReplyAfterWaitingInput(comments) {
  if (!Array.isArray(comments)) return null;
  let lastIdx = -1;
  comments.forEach((c, i) => {
    if (isWaitingInputByAgent(c?.body)) lastIdx = i;
  });
  if (lastIdx === -1) return null;
  for (let i = lastIdx + 1; i < comments.length; i++) {
    if (isUserReply(comments[i])) {
      return comments[i];
    }
  }
  return null;
}

/**
 * 「最新の waiting-input より後に、エージェント発の answered があるか」を判定する。
 *
 * 司が waiting-input の質問に対しターミナルペインで直接回答したケースでは、GitHub 上に
 * ユーザー返信コメントが付かない。司は別途 `Comment by vk-agents` + `Status: answered` の
 * コメントを出して「ペイン経由で解決済み」を明示宣言する。これを検知して、転送不要のまま
 * pending を解除する（in-progress 復帰）ために使う。
 *
 * 直近のエージェント発 waiting-input のインデックスを求め、それより**後**に
 * 「エージェント発かつ status==='answered'」のコメントがあれば true、無ければ false。
 * waiting-input が 1 つも無ければ false。
 *
 * 「waiting-input → answered → 再度 waiting-input」のような再質問シーケンスでは、
 * 最新 waiting-input の後に answered が無いので false（＝待ち直す）になり正しい。
 * 構造は `findReplyAfterWaitingInput`（最新 waiting-input の後の最初の返信を探す）と
 * 対称に、走査対象をエージェント発 answered に置き換えたもの。
 *
 * @param {Array<{ body?: string }>} comments 作成日時の昇順で渡す前提
 * @returns {boolean}
 */
export function hasAgentAnsweredAfterWaitingInput(comments) {
  if (!Array.isArray(comments)) return false;
  let lastIdx = -1;
  comments.forEach((c, i) => {
    if (isWaitingInputByAgent(c?.body)) lastIdx = i;
  });
  if (lastIdx === -1) return false;
  for (let i = lastIdx + 1; i < comments.length; i++) {
    const { isAgentComment, status } = parseDecisionRecordComment(comments[i]?.body);
    if (isAgentComment && status === 'answered') return true;
  }
  return false;
}
