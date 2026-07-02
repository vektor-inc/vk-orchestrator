/**
 * `status:in-progress` の task-queue issue について、次に取るべき状態遷移を
 * 決める純粋関数（新方針 案B：ステートレス・スキャナ方式の中核ロジック）。
 *
 * orchestrator は秒数ではなく GitHub 上の客観状態で遷移する：
 *   - 対象 issue/PR の decision-record コメント（未応答の指示待ち）→ waiting-input
 *   - 対象 PR がマージ済み → merged（呼び出し側で done ゲートを通す）
 *   - 対象 PR が未マージ closed → pr-closed-unmerged（failed 相当）
 *   - 対象 PR が完了条件（CI + CodeRabbit 静観）を満たす → waiting-merge
 *   - いずれでもない → none（まだ作業中）
 *
 * PR URL の本文記録・PR アイコン表示は「状態遷移」とは独立の副作用として
 * 呼び出し側が（pr が存在し未記録なら）冪等に行う。この関数は遷移種別だけを返す。
 *
 * GitHub API 依存を持たない純粋関数として切り出し、ユニットテスト可能にしている。
 *
 * ## automerge ラベルと waiting-input の関係
 *
 * `automerge` ラベルは「マージ手順を事前承認する」ことを意味する。司（vk-kore）が
 * 完了報告で「マージ判断をお願いします」という `Status: waiting-input` コメントを
 * 出すと、本来 automerge で自動マージされるべき PR が waiting-input で止まってしまう
 * （automerge ラベルを対象リポ側 issue だけで探して見落とすなど、司側の判断ミスでも
 * 起きうる）。これを司の記憶やスキル運用に頼らず orchestrator 側で防ぐため、automerge
 * 指定時は **PR の客観状態が「実装完了」を示しているとき（マージ済み、または open かつ
 * 完了条件充足）に限り**、未応答の waiting-input を「マージ判断依頼（事前承認済み）」と
 * みなして waiting-input に倒さず PR 遷移（merged / waiting-merge）へ進める。
 *
 * 逆に automerge でも **PR がまだ完了条件を満たさない段階**（実装途中の仕様確認など、
 * 本物の判断待ち）では従来どおり waiting-input に倒す。automerge が事前承認するのは
 * あくまでマージ手順であって実装方針ではないこと、および waiting-input は
 * ユーザー返信を pane へ転送する経路でもある（ここを潰すと本物の質問に返信できない）
 * ことから、override は完了済み PR に限定する。判定材料はコメント本文の意図解析では
 * なく PR の客観状態のみに置く。
 */

import { hasPendingWaitingInput } from './decision-record.js';

/**
 * @param {object} input
 * @param {Array<{ body?: string }>} [input.comments]  対象 issue/PR のコメント（昇順）
 * @param {null|{ state: 'open'|'closed', merged: boolean }} [input.pr]  対象 PR の状態（無ければ null）
 * @param {boolean} [input.prCompletionReady]  PR が完了条件を満たすか（pr が null のときは無視）
 * @param {boolean} [input.automerge]  対象メタ issue に automerge ラベルが付いているか
 * @returns {{ type: 'waiting-input'|'merged'|'pr-closed-unmerged'|'waiting-merge'|'none' }}
 */
export function decideInProgressAction({
  comments = [],
  pr = null,
  prCompletionReady = false,
  automerge = false,
} = {}) {
  // automerge 指定時、PR の客観状態が「実装完了」を示しているなら、未応答の
  // waiting-input は「マージ判断依頼（automerge で事前承認済み）」とみなし、
  // waiting-input に倒さず下の PR 遷移へ進める（マージ手順だけを事前承認する）。
  // PR が未完了の段階での waiting-input は本物の判断待ちなので override しない。
  const automergeOverridesPending =
    automerge &&
    pr != null &&
    (pr.merged || (pr.state === 'open' && prCompletionReady));

  // 1. 未応答の waiting-input があれば原則として指示待ちに倒す（人の判断待ち）。
  //    ただし automerge の「完了済み PR に対するマージ判断依頼」は override する。
  if (hasPendingWaitingInput(comments) && !automergeOverridesPending) {
    return { type: 'waiting-input' };
  }

  // 2. PR の客観状態に応じた遷移。
  if (pr) {
    if (pr.merged) return { type: 'merged' };
    if (pr.state === 'closed') return { type: 'pr-closed-unmerged' };
    if (prCompletionReady) return { type: 'waiting-merge' };
  }

  // 3. まだ作業中。
  return { type: 'none' };
}
