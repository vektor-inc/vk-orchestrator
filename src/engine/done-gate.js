// -------------------------------------------------------
// done 遷移ゲート（共通ヘルパー）
// -------------------------------------------------------
// タスク登録リポジトリ側 issue を `status:done` に遷移させてよいかを判定する共通ゲート。
//
// 背景: タスク登録リポジトリ側 issue を done 化する経路は複数存在する（scanInProgressIssues /
// checkWaitingMergeIssues / recheckFailedIssues）。これらが「対象 PR がマージ済みか」
// だけで判定していたため、
// 対象 issue がまだ open（= 部分対応のみマージされた状態）でもタスク登録リポジトリ側が
// 自動 close されてしまう不具合があった（task-queue#49 の事象）。
//
// このヘルパーを done 遷移直前に呼ぶことで、対象 issue が open のうちは
// タスク登録リポジトリ側を done 化しないように一元的にガードする。さらに GitHub
// ネイティブ sub-issue がぶら下がっている場合は、直下の全 sub-issue が closed に
// なるまで done 化を見送る。
//
// 仕様:
//   - 本文に対象 issue URL が無い（task-queue 内部完結タスク等） → done OK
//   - 対象 issue が closed かつ sub-issue が無い / 全 sub-issue が closed → done OK
//   - 対象 issue が open  → done スキップ（呼び出し側は現状ラベル維持・コメント省略）
//   - 対象 issue の直下 sub-issue に open がある → done スキップ
//   - 対象 issue の state / sub-issue 状態取得に失敗 → 安全側に倒して done スキップ
//     （次ループで再試行される）
//   - getSubIssueStates が注入されていない旧呼び出し → 従来どおり親 issue state のみで判定
//
// `index.js` 側の `extractGitHubIssueUrl` と GitHubClient の `getIssueState` /
// `listSubIssueStates` を依存注入で受け取る純粋関数。ユニットテストでは fake を渡してテストする。

/**
 * @param {object}   issue              タスク登録リポジトリ側 issue（{ number, title, body }）
 * @param {object}   deps
 * @param {function} deps.extractGitHubIssueUrl  index.js の同名関数
 * @param {function} deps.getIssueState          (owner, repo, number) => Promise<{ state }>
 * @param {function} [deps.getSubIssueStates]    (owner, repo, number) => Promise<Array<{ owner, repo, number, state }>>
 * @param {object}   [options]
 * @param {string}   [options.logTag='[done-gate]']    呼び出し元のログタグ
 * @param {object}   [options.logger=console]         console 互換オブジェクト
 * @returns {Promise<boolean>}  true なら done に遷移してよい / false なら見送り
 */
export async function canTransitionToDone(issue, deps, options = {}) {
  const { extractGitHubIssueUrl, getIssueState, getSubIssueStates } = deps;
  const { logTag = '[done-gate]', logger = console } = options;

  const target = extractGitHubIssueUrl(
    [issue.title, issue.body].filter(Boolean).join('\n')
  );
  if (!target) return true;

  let state;
  try {
    const result = await getIssueState(target.owner, target.repo, target.number);
    state = result.state;
  } catch (err) {
    logger.warn(
      `  ${logTag} issue #${issue.number}: 対象 ${target.owner}/${target.repo}#${target.number} の状態取得失敗 → done への遷移を見送り次ループで再評価: ${err.message}`
    );
    return false;
  }

  if (state !== 'closed') {
    logger.log(
      `  ${logTag} issue #${issue.number}: 対象 ${target.owner}/${target.repo}#${target.number} が ${state} のため done への遷移を見送り（ラベルは現状維持）`
    );
    return false;
  }

  if (typeof getSubIssueStates !== 'function') {
    return true;
  }

  let subIssues;
  try {
    subIssues = await getSubIssueStates(target.owner, target.repo, target.number);
  } catch (err) {
    logger.warn(
      `  ${logTag} issue #${issue.number}: 対象 ${target.owner}/${target.repo}#${target.number} の sub-issue 状態取得失敗 → done への遷移を見送り次ループで再評価: ${err.message}`
    );
    return false;
  }

  const incompleteSubIssues = subIssues.filter(subIssue => subIssue.state !== 'closed');
  if (incompleteSubIssues.length > 0) {
    const refs = incompleteSubIssues
      .map(subIssue => `${subIssue.owner}/${subIssue.repo}#${subIssue.number}(${subIssue.state})`)
      .join(', ');
    logger.log(
      `  ${logTag} issue #${issue.number}: 対象 ${target.owner}/${target.repo}#${target.number} の sub-issue が未完了のため done への遷移を見送り: ${refs}`
    );
    return false;
  }

  return true;
}
