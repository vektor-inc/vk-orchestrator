// -------------------------------------------------------
// オーケストレーター永続ログ
//
// start の標準出力は VK Terminals 側のバッファに依存し、過去ログが流れると
// 調査不能になる。console 出力を維持しつつ、同じ内容を
// ~/.task-queue/logs/orchestrator.log にも追記する。
//
// ログ書き込みは診断用の副作用なので、失敗しても本処理は止めない。初回失敗時だけ
// 元の console.warn に通知し、それ以降は静かに継続する。
// -------------------------------------------------------

import nodeFs from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

import { redactSecrets as defaultRedactSecrets } from './redact-secrets.js';

export const DEFAULT_LOG_MAX_BYTES = 1024 * 1024;

export function defaultOrchestratorLogFile({ homeDir = homedir() } = {}) {
  return join(homeDir, '.task-queue', 'logs', 'orchestrator.log');
}

export function createPersistentLogger({
  logFile = defaultOrchestratorLogFile(),
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  console: targetConsole = console,
  fs = nodeFs,
  now = () => new Date(),
  redactSecrets = defaultRedactSecrets,
} = {}) {
  let writeFailedWarned = false;

  const writeLine = (level, args) => {
    try {
      fs.mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
      rotateIfNeeded({ fs, logFile, maxBytes });
      const body = redactSecrets(formatArgs(args));
      // mode は新規作成時だけ適用される。既存ログは chmod せず、以後の作成既定だけ締める。
      fs.appendFileSync(logFile, `[${now().toISOString()}] [${level}] ${body}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      if (!writeFailedWarned) {
        writeFailedWarned = true;
        targetConsole.warn?.(`[logger] 永続ログへの書き込みに失敗しました（処理は継続）: ${err.message}`);
      }
    }
  };

  return {
    log(...args) {
      targetConsole.log?.(...args);
      writeLine('log', args);
    },
    warn(...args) {
      targetConsole.warn?.(...args);
      writeLine('warn', args);
    },
    error(...args) {
      targetConsole.error?.(...args);
      writeLine('error', args);
    },
  };
}

export function installPersistentConsoleLogger(options = {}) {
  const targetConsole = options.console ?? console;
  const original = {
    log: targetConsole.log?.bind(targetConsole),
    warn: targetConsole.warn?.bind(targetConsole),
    error: targetConsole.error?.bind(targetConsole),
  };
  const logger = createPersistentLogger({
    ...options,
    console: {
      log: original.log ?? (() => {}),
      warn: original.warn ?? (() => {}),
      error: original.error ?? (() => {}),
    },
  });

  targetConsole.log = logger.log;
  targetConsole.warn = logger.warn;
  targetConsole.error = logger.error;

  return {
    logger,
    logFile: options.logFile ?? defaultOrchestratorLogFile(),
    restore() {
      if (original.log) targetConsole.log = original.log;
      if (original.warn) targetConsole.warn = original.warn;
      if (original.error) targetConsole.error = original.error;
    },
  };
}

function rotateIfNeeded({ fs, logFile, maxBytes }) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;

  let stat;
  try {
    stat = fs.statSync(logFile);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  if (stat.size < maxBytes) return;

  const rotated = `${logFile}.1`;
  try {
    fs.rmSync(rotated, { force: true });
  } catch {
    // 古いローテートファイルの削除失敗は rename 側で検出する。
  }
  fs.renameSync(logFile, rotated);
}

function formatArgs(args) {
  return args.map(formatArg).join(' ');
}

function formatArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  if (value == null) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
