import { resolveTasksViewPath, writeJsonAtomic } from '../config.js';

const ISSUE_URL_RE = /https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/issues\/\d+/;
const PR_URL_RE = /\*\*PR:\*\*\s*(https:\/\/github\.com\/[^\s]+\/pull\/\d+)/g;
const PRIORITY_PREFIX = 'priority:';
const PRIORITY_VALUES = new Set(['high', 'medium', 'low']);

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function assigneeLogin(assignee) {
  if (typeof assignee === 'string') return assignee;
  return assignee?.login ?? null;
}

export function extractTargetIssueUrl(body) {
  if (!body) return null;
  return body.match(ISSUE_URL_RE)?.[0] ?? null;
}

export function extractPRUrl(body) {
  if (!body) return null;
  const matches = [...body.matchAll(PR_URL_RE)];
  return matches.length > 0 ? matches.at(-1)[1] : null;
}

export function normalizeTaskIssue(issue) {
  const labels = (issue.labels ?? [])
    .map(labelName)
    .filter((name) => typeof name === 'string' && name !== '');
  const statusLabel = labels.find((name) => name.startsWith('status:')) ?? null;
  const priorityLabel = labels.find((name) => name.startsWith(PRIORITY_PREFIX)) ?? null;
  const priority = priorityLabel?.slice(PRIORITY_PREFIX.length) ?? null;
  const assignees = (issue.assignees ?? [])
    .map(assigneeLogin)
    .filter((login) => typeof login === 'string' && login !== '');

  return {
    id: String(issue.number),
    number: issue.number,
    title: issue.title ?? '',
    status: statusLabel ? statusLabel.slice('status:'.length) : null,
    statusLabel,
    priority: PRIORITY_VALUES.has(priority) ? priority : null,
    sequential: labels.includes('sequential'),
    assignee: assignees[0] ?? null,
    assignees,
    targetIssueUrl: extractTargetIssueUrl(issue.body),
    prUrl: extractPRUrl(issue.body),
    queueIssueUrl: issue.html_url ?? issue.htmlUrl ?? null,
    updatedAt: issue.updated_at ?? issue.updatedAt ?? null,
  };
}

// assignee フィルタ値から「自分（viewer）」のログイン名を解決する。
// 具体的なログイン名（非空・`all` 以外）ならその値（前後空白は trim、大小文字は保持）、
// `all`（大小文字問わず）/ 空文字 / null / undefined など単一の自分を特定できない場合は null。
function resolveViewer(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'all') return null;
  return trimmed;
}

export function buildTasksView(issues, options = {}) {
  const now = options.now ?? new Date();
  const updatedAt = now instanceof Date ? now.toISOString() : String(now);
  return {
    updatedAt,
    viewer: resolveViewer(options.viewer),
    tasks: issues
      .filter((issue) => !issue.pull_request)
      .map(normalizeTaskIssue),
  };
}

// タスクキュー上の全タスク（open issue）を取得する。
// クライアント抽象のインターフェースメソッド経由でのみ取得し、GitHub API を直叩きしない
// （キューの保存先を GitHub 以外に差し替え可能にするため）。
export async function fetchAllTaskQueueIssues(github) {
  return github.listAllQueueIssues();
}

export async function writeTasksViewFile(view, options = {}) {
  const filePath = options.filePath ?? resolveTasksViewPath();
  writeJsonAtomic(filePath, view);
  return filePath;
}

export async function writeTasksViewSnapshot(github, options = {}) {
  const issues = options.issues ?? await fetchAllTaskQueueIssues(github);
  const view = buildTasksView(issues, { now: options.now, viewer: options.viewer });
  const filePath = await writeTasksViewFile(view, { filePath: options.filePath });
  return { filePath, view };
}

export async function refreshTasksViewSnapshot(github, options = {}) {
  const logger = options.logger ?? console;
  try {
    return await writeTasksViewSnapshot(github, options);
  } catch (err) {
    logger.warn?.(`[tasks-view] tasks-view.json 書き出し失敗（処理は継続）: ${err.message}`);
    return null;
  }
}
