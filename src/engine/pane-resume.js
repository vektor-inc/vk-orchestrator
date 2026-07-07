// -------------------------------------------------------
// pane 消失時の自動再開（共通ヘルパー）
// -------------------------------------------------------
// scanWatchdog が「作業ペイン（termId）の消失」を確定させた後の処理。
//
// 背景: 従来は pane 消失＝即 `status:failed`＋手動確認コメントで止まっていた
// （task-queue#246 の事象）。しかし VK Terminals の再起動・GUI の一時終了・
// ペインのクラッシュは運用上そこそこ起きるうえ、PR がまだ無い（＝マージ待ちの
// 成果物が無い）タスクは安全にやり直せる。そこで
//
//   - 対象 issue に PR が存在しない
//   - pane が消失している（idle ではなく居ない）
//
// の両方を満たす場合に限り、`status:ready` に戻して自動で再キューする。
// 無限リトライ防止として state に再開回数（resumeCount）を持たせ、上限
// （既定 3 回。PANE_RESUME_MAX で上書き可）を超えたら従来どおり failed に倒す。
//
// idle タイムアウト（WATCHDOG_IDLE）はこのヘルパーを通らない。pane が生きて
// いる場合に勝手に再開すると作業中の Claude を潰すリスクがあるため、従来どおり
// failed＋手動確認のままにする（この関数のスコープは「pane 消失」に限定）。
//
// `done-gate.js` と同様、GitHub / state / cleanup への副作用は全て依存注入で
// 受け取る（ユニットテストでは fake を渡してテストする）。

// 自動再開上限の既定値。
export const DEFAULT_RESUME_MAX = 3;

/**
 * 自動再開の上限回数を健全化する。
 *
 * 上限判定 `resumeCount > resumeMax` は resumeMax が NaN だと常に false になり、
 * 無限リトライ防止（本機能の唯一の安全装置）が沈黙のうちに外れる。逆に負数だと
 * 常に即 failed になる。そのため env / config / 依存注入のどこから来た値でも、
 * 有限数かつ 0 以上のときだけ採用（小数は切り捨て）し、それ以外は既定値に
 * フォールバックする（fail-closed）。0 は「自動再開を無効化して常に failed」
 * という有効な設定値として許容する。
 *
 * @param {*} value 環境変数・config・options 経由の生値
 * @param {number} [fallback=DEFAULT_RESUME_MAX] 不正値時のフォールバック
 * @returns {number} 0 以上の整数
 */
export function normalizeResumeMax(value, fallback = DEFAULT_RESUME_MAX) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * pane 消失が確定したタスクを、条件を満たせば自動再開（再キュー）する。
 *
 * @param {object}   issue   task-queue 側 issue（{ number, title, body }）
 * @param {object}   saved   state.json のタスクレコード（{ termId, wpPort, resumeCount, ... }）
 * @param {object}   deps
 * @param {function} deps.findPRForIssue        (owner, repo, number) => Promise<pr|null>
 * @param {function} deps.resolveTarget         (issue) => { owner, repo, number }
 * @param {function} deps.cleanupForIssue       ({ issueNumber, wpPort }) => Promise<summary>
 * @param {function} deps.formatCleanupSummary  (summary) => string
 * @param {function} deps.updateTask            (issueNumber, patch) => Promise<void>
 * @param {function} deps.setStatus             (issueNumber, label) => Promise<void>
 * @param {function} deps.addComment            (issueNumber, body) => Promise<void>
 * @param {function} deps.failTask              (reason) => Promise<void> 従来の failed 化処理
 * @param {object}   [options]
 * @param {number}   [options.resumeMax=3]      自動再開の上限回数（NaN・負数等の不正値は既定 3 にフォールバック）
 * @param {string}   [options.logTag='[watchdog]']  呼び出し元のログタグ
 * @param {object}   [options.logger=console]   console 互換オブジェクト
 * @returns {Promise<{action: 'skipped'|'has-pr'|'failed'|'retry'|'resumed', resumeCount?: number}>}
 *   - skipped : PR 確認に失敗（今回は何もしない。次ループで再評価）
 *   - has-pr  : PR あり（通常ルートに任せるため何もしない）
 *   - failed  : 再開上限超過（従来どおり failed に倒した）
 *   - retry   : ready 遷移に失敗（state は据え置き。次ループで pane 消失から再検知）
 *   - resumed : 自動再開した（status:ready へ戻した）
 */
export async function handlePaneMissing(issue, saved, deps, options = {}) {
  const {
    findPRForIssue,
    resolveTarget,
    cleanupForIssue,
    formatCleanupSummary,
    updateTask,
    setStatus,
    addComment,
    failTask,
  } = deps;
  const { logTag = '[watchdog]', logger = console } = options;
  // 依存注入経由で不正値（NaN・負数・非数値）が来ても上限判定が壊れないよう健全化する。
  const resumeMax = normalizeResumeMax(options.resumeMax ?? DEFAULT_RESUME_MAX);

  const termId = saved?.termId ?? null;

  // 1. PR の有無を確認。PR があれば scanInProgress / merge-watch の通常ルートが
  //    駆動するので何もしない（誤って進行中タスクを再キューしないための保険）。
  const target = resolveTarget(issue);
  let pr = null;
  try {
    pr = await findPRForIssue(target.owner, target.repo, target.number);
  } catch (err) {
    logger.warn(`  ${logTag} issue #${issue.number}: PR 確認失敗（今回は見送り）: ${err.message}`);
    return { action: 'skipped' };
  }
  if (pr) return { action: 'has-pr' };

  // 2. 再開上限の判定。超過していたら従来どおり failed＋手動確認に倒す。
  const resumeCount = (saved?.resumeCount ?? 0) + 1;
  if (resumeCount > resumeMax) {
    await failTask(
      `作業ペイン（termId:${termId}）が消失しました（自動再開の上限 ${resumeMax} 回を使い切りました）`
    );
    return { action: 'failed' };
  }

  // 3. 再開回数を「ready 遷移より先に」記録する。後段の setStatus が失敗して
  //    次ループで再試行になっても resumeCount は単調増加するため、遷移失敗の
  //    繰り返しが無限リトライに化けない（安全側に倒す）。
  try {
    await updateTask(issue.number, { resumeCount });
  } catch (err) {
    logger.warn(`  ${logTag} issue #${issue.number}: 再開回数の記録失敗（処理は継続）: ${err.message}`);
  }

  // 4. クラッシュで残った wp-env コンテナ・worktree を掃除する（失敗しても再開は続行）。
  let cleanupReport = null;
  if (saved?.wpPort != null) {
    try {
      const summary = await cleanupForIssue({ issueNumber: issue.number, wpPort: saved.wpPort });
      cleanupReport = formatCleanupSummary(summary);
    } catch (err) {
      cleanupReport = `⚠️ クリーンアップ中にエラー: ${err.message}`;
    }
  }

  // 5. ready へ戻して再実行させる。失敗時は state を据え置いて次ループに送る
  //    （termId が残っていれば scanWatchdog が pane 消失を再検知して再試行できる）。
  try {
    await setStatus(issue.number, 'status:ready');
  } catch (err) {
    logger.warn(`  ${logTag} issue #${issue.number}: 自動再開（ready 遷移）失敗（次ループ再試行）: ${err.message}`);
    return { action: 'retry', resumeCount };
  }

  // 6. state の termId / paneMissingTicks / wpPort を明示的にリセットする。
  //    再ディスパッチ時に recordTaskStart が上書きする想定だが、消失済みペインの
  //    残骸を参照させないよう再開時点で消しておく（resumeCount は 3. で記録済み）。
  try {
    await updateTask(issue.number, { termId: null, paneMissingTicks: 0, wpPort: null });
  } catch (err) {
    logger.warn(`  ${logTag} issue #${issue.number}: state リセット失敗（処理は継続）: ${err.message}`);
  }

  // 7. 再開したことを issue に残す（失敗しても再開自体は成立しているので warn のみ）。
  try {
    await addComment(
      issue.number,
      [
        `🔁 作業ペイン消失を検知したため自動再開しました（${resumeCount}/${resumeMax}回目）`,
        cleanupReport ? `\n**クリーンアップ結果:**\n${cleanupReport}` : '',
      ].filter(Boolean).join('\n')
    );
  } catch (err) {
    logger.warn(`  ${logTag} issue #${issue.number}: 自動再開コメント投稿失敗（処理は継続）: ${err.message}`);
  }

  logger.log(
    `  ${logTag} issue #${issue.number}: pane(termId:${termId}) 消失 → 自動再開 ready（${resumeCount}/${resumeMax}回目）`
  );
  return { action: 'resumed', resumeCount };
}
