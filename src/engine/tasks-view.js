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

export function buildTasksView(issues, options = {}) {
  const now = options.now ?? new Date();
  const updatedAt = now instanceof Date ? now.toISOString() : String(now);
  return {
    updatedAt,
    tasks: issues
      .filter((issue) => !issue.pull_request)
      .map(normalizeTaskIssue),
  };
}

export async function fetchAllTaskQueueIssues(github) {
  const params = {
    owner: github.owner,
    repo: github.repo,
    state: 'open',
    sort: 'updated',
    direction: 'desc',
    per_page: 100,
  };

  if (typeof github.octokit?.paginate === 'function') {
    return github.octokit.paginate(github.octokit.issues.listForRepo, params);
  }

  const { data } = await github.octokit.issues.listForRepo(params);
  return data;
}

export async function writeTasksViewFile(view, options = {}) {
  const filePath = options.filePath ?? resolveTasksViewPath();
  writeJsonAtomic(filePath, view);
  return filePath;
}

export async function writeTasksViewSnapshot(github, options = {}) {
  const issues = options.issues ?? await fetchAllTaskQueueIssues(github);
  const view = buildTasksView(issues, { now: options.now });
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
