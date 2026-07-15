// done-gate の直前で、作業対象リポジトリ側 issue を close するための小さな副作用ヘルパー。
// GitHub API 失敗時はメタ issue の状態遷移を壊さず、次ループで再試行できるよう warn のみで握る。
export async function closeSourceIssueBeforeGate(issue, deps, options = {}) {
  const { extractGitHubIssueUrl, closeSourceIssue, getSubIssueStates } = deps;
  const logger = options.logger ?? console;
  const logTag = options.logTag ?? '[source-close]';
  const target = extractGitHubIssueUrl(
    [issue.title, issue.body].filter(Boolean).join('\n')
  );

  if (!target) return false;

  if (typeof getSubIssueStates === 'function') {
    let subIssues;
    try {
      subIssues = await getSubIssueStates(target.owner, target.repo, target.number);
    } catch (err) {
      logger.warn(
        `  ${logTag} issue #${issue.number}: 本体 ${target.owner}/${target.repo}#${target.number} の sub-issue 状態取得失敗のため close を見送り（次ループ再試行）: ${err.message}`
      );
      return false;
    }

    const incompleteSubIssues = subIssues.filter(subIssue => subIssue.state !== 'closed');
    if (incompleteSubIssues.length > 0) {
      const refs = incompleteSubIssues
        .map(subIssue => `${subIssue.owner}/${subIssue.repo}#${subIssue.number}(${subIssue.state})`)
        .join(', ');
      logger.log?.(
        `  ${logTag} issue #${issue.number}: 本体 ${target.owner}/${target.repo}#${target.number} の sub-issue が未完了のため close を見送り: ${refs}`
      );
      return false;
    }
  }

  try {
    await closeSourceIssue(target);
    return true;
  } catch (err) {
    logger.warn(
      `  ${logTag} issue #${issue.number}: 本体 ${target.owner}/${target.repo}#${target.number} の close 失敗（次ループ再試行）: ${err.message}`
    );
    return false;
  }
}
