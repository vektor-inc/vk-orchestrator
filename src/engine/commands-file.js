import { promises as fsPromises, watch as fsWatch } from 'fs';
import { basename, dirname, join } from 'path';
import { DEFAULT_LABELS, getLabelsConfig, resolveCommandsPath } from '../config.js';

const STATUS_PREFIX = 'status:';
const ALLOWED_TRANSITIONS = new Set([
  'awaiting-approval->ready',
  'ready->awaiting-approval',
  'waiting-merge->done',
  'failed->ready',
  'ready->failed',
]);

function labelName(label) {
  return typeof label === 'string' ? label : label?.name;
}

function statusLabelsFromConfig(labelsConfig = getLabelsConfig()) {
  return labelsConfig?.status ?? DEFAULT_LABELS.status;
}

export function buildStatusLabelMaps(labelsConfig = getLabelsConfig()) {
  const statusLabels = statusLabelsFromConfig(labelsConfig);
  const bareToLabel = new Map();
  const labelToBare = new Map();

  for (const label of Object.values(statusLabels)) {
    if (typeof label !== 'string' || !label.startsWith(STATUS_PREFIX)) continue;
    const bare = label.slice(STATUS_PREFIX.length);
    bareToLabel.set(bare, label);
    labelToBare.set(label, bare);
  }

  return { bareToLabel, labelToBare };
}

export function normalizeStatusName(value, labelsConfig = getLabelsConfig()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const { bareToLabel, labelToBare } = buildStatusLabelMaps(labelsConfig);
  if (labelToBare.has(raw)) return labelToBare.get(raw);

  const bare = raw.startsWith(STATUS_PREFIX) ? raw.slice(STATUS_PREFIX.length) : raw;
  return bareToLabel.has(bare) ? bare : null;
}

export function statusLabelFor(value, labelsConfig = getLabelsConfig()) {
  const bare = normalizeStatusName(value, labelsConfig);
  if (!bare) return null;
  return buildStatusLabelMaps(labelsConfig).bareToLabel.get(bare) ?? null;
}

export function isAllowedTransition(from, to) {
  const normalizedFrom = typeof from === 'string' && from.startsWith(STATUS_PREFIX)
    ? from.slice(STATUS_PREFIX.length)
    : String(from ?? '');
  const normalizedTo = typeof to === 'string' && to.startsWith(STATUS_PREFIX)
    ? to.slice(STATUS_PREFIX.length)
    : String(to ?? '');
  return ALLOWED_TRANSITIONS.has(`${normalizedFrom}->${normalizedTo}`);
}

export function extractIssueStatus(issue, labelsConfig = getLabelsConfig()) {
  const labels = (issue?.labels ?? [])
    .map(labelName)
    .filter((name) => typeof name === 'string' && name !== '');
  const statusLabel = labels.find((name) => name.startsWith(STATUS_PREFIX));
  return statusLabel ? normalizeStatusName(statusLabel, labelsConfig) : null;
}

function normalizeTaskId(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function parseCommandLine(line, lineNumber, logger) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn?.(`[commands-file] ${lineNumber} 行目は JSON object ではないため無視します`);
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn?.(`[commands-file] ${lineNumber} 行目の JSON パースに失敗したため無視します: ${err.message}`);
    return null;
  }
}

export async function readProcessedCommandIds(processedPath) {
  try {
    const text = await fsPromises.readFile(processedPath, 'utf8');
    const parsed = JSON.parse(text);
    const ids = Array.isArray(parsed) ? parsed : parsed?.ids;
    if (!Array.isArray(ids)) return new Set();
    return new Set(ids.map((id) => String(id)).filter((id) => id !== ''));
  } catch (err) {
    if (err.code === 'ENOENT') return new Set();
    throw err;
  }
}

export async function writeProcessedCommandIds(processedPath, ids, now = new Date()) {
  await fsPromises.mkdir(dirname(processedPath), { recursive: true });
  const tmpPath = join(
    dirname(processedPath),
    `.${basename(processedPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const payload = {
    ids: [...ids].sort(),
    updatedAt: now instanceof Date ? now.toISOString() : String(now),
  };
  await fsPromises.writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await fsPromises.rename(tmpPath, processedPath);
}

function validateCommand(command, logger) {
  const id = command?.id == null ? '' : String(command.id).trim();
  if (!id) {
    logger.warn?.('[commands-file] id が無いコマンドを無視します');
    return null;
  }

  const taskId = normalizeTaskId(command.taskId);
  if (taskId == null) {
    logger.warn?.(`[commands-file] id=${id}: taskId が不正なため無視します`);
    return null;
  }

  if (command.action == null || command.to == null || command.expected == null || command.requestedAt == null) {
    logger.warn?.(`[commands-file] id=${id}: 必須キーが不足しているため無視します`);
    return null;
  }

  return { id, taskId };
}

export async function processSetStatusCommand(command, dependencies = {}) {
  const logger = dependencies.logger ?? console;
  const labelsConfig = dependencies.labelsConfig ?? getLabelsConfig();
  const github = dependencies.github;
  const getMetaIssue = dependencies.getMetaIssue;

  const valid = validateCommand(command, logger);
  if (!valid) return { evaluated: false, applied: false, reason: 'invalid' };

  const { id, taskId } = valid;
  if (command.action !== 'set-status') {
    logger.warn?.(`[commands-file] id=${id}: 未対応 action "${command.action}" のため無視します`);
    return { evaluated: true, applied: false, reason: 'unsupported-action', id };
  }

  const expected = normalizeStatusName(command.expected, labelsConfig);
  const to = normalizeStatusName(command.to, labelsConfig);
  if (!expected || !to) {
    logger.warn?.(`[commands-file] id=${id}: expected/to のステータス名が不正なため拒否します`);
    return { evaluated: true, applied: false, reason: 'invalid-status', id };
  }

  if (!isAllowedTransition(expected, to)) {
    logger.warn?.(`[commands-file] id=${id}: 許可されていない遷移 ${expected} → ${to} のため拒否します`);
    return { evaluated: true, applied: false, reason: 'disallowed-transition', id };
  }

  const issue = await getMetaIssue(taskId);
  const actual = extractIssueStatus(issue, labelsConfig);
  if (actual !== expected) {
    logger.info?.(`[commands-file] id=${id}: CAS 不一致（expected=${expected}, actual=${actual ?? 'none'}）のため破棄します`);
    return { evaluated: true, applied: false, reason: 'cas-mismatch', id };
  }

  const nextLabel = statusLabelFor(to, labelsConfig);
  await github.setStatus(taskId, nextLabel);
  logger.info?.(`[commands-file] id=${id}: issue #${taskId} を ${nextLabel} へ変更しました`);
  return { evaluated: true, applied: true, reason: 'applied', id };
}

export async function consumeCommandsFile(options = {}) {
  const commandsPath = options.commandsPath ?? resolveCommandsPath();
  const processedPath = options.processedPath ?? join(dirname(commandsPath), 'commands-processed.json');
  const logger = options.logger ?? console;
  const now = options.now ?? (() => new Date());
  const github = options.github;
  const getMetaIssue = options.getMetaIssue ?? ((issueNumber) =>
    github.getIssueState(github.owner, github.repo, issueNumber, { retryDelays: [] })
  );

  let text;
  try {
    text = await fsPromises.readFile(commandsPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { read: 0, evaluated: 0, applied: 0, skipped: 0 };
    throw err;
  }

  let processed = await readProcessedCommandIds(processedPath);
  let changed = false;
  const summary = { read: 0, evaluated: 0, applied: 0, skipped: 0 };
  const lines = text.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const command = parseCommandLine(line, index + 1, logger);
    if (!command) continue;

    summary.read += 1;
    const id = command.id == null ? '' : String(command.id).trim();
    if (id && processed.has(id)) {
      summary.skipped += 1;
      continue;
    }

    let result;
    try {
      result = await processSetStatusCommand(command, { ...options, github, getMetaIssue });
    } catch (err) {
      logger.warn?.(`[commands-file] id=${id || '(unknown)'}: 処理に失敗しました（次回再試行）: ${err.message}`);
      continue;
    }

    if (result.evaluated) {
      summary.evaluated += 1;
      if (result.id) {
        processed.add(result.id);
        changed = true;
      }
      if (result.applied) summary.applied += 1;
    }
  }

  if (changed) {
    await writeProcessedCommandIds(processedPath, processed, now());
  }

  return summary;
}

export function createCommandsFileProcessor(options = {}) {
  let chain = Promise.resolve();
  const consumeOnce = () => {
    const next = chain.then(() => consumeCommandsFile(options));
    chain = next.catch(() => {});
    return next;
  };
  return { consumeOnce };
}

export function startCommandsFileWatcher(processor, options = {}) {
  const commandsPath = options.commandsPath ?? resolveCommandsPath();
  const logger = options.logger ?? console;
  const debounceMs = options.debounceMs ?? 200;
  let timer = null;
  let closed = false;
  let watcher = null;

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      processor.consumeOnce().catch((err) => {
        logger.warn?.(`[commands-file] watch 起点の消化に失敗しました: ${err.message}`);
      });
    }, debounceMs);
  };

  fsPromises.mkdir(dirname(commandsPath), { recursive: true })
    .then(() => {
      if (closed) return;
      watcher = fsWatch(dirname(commandsPath), (eventType, filename) => {
        if (!filename || filename === basename(commandsPath)) schedule();
      });
      watcher.on('error', (err) => {
        logger.warn?.(`[commands-file] watch に失敗しました: ${err.message}`);
      });
    })
    .catch((err) => {
      logger.warn?.(`[commands-file] watch ディレクトリの作成に失敗しました: ${err.message}`);
    });

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      watcher?.close();
    },
  };
}
