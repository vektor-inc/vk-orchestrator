// -------------------------------------------------------
// start 多重起動防止ロック
//
// watch と --once はどちらも同じ state.json を読み書きするため、同時起動すると
// termId の逆引き失敗や state の取りこぼしを起こしうる。起動時に PID ロックを
// 取得し、生存中プロセスがいれば明示的に中止する。
// -------------------------------------------------------

import nodeFs, { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export function defaultStartLockFile({ homeDir = homedir() } = {}) {
  return join(homeDir, '.task-queue', 'orchestrator.lock');
}

export function createStartLock({
  lockFile = defaultStartLockFile(),
  process: processApi = process,
  now = () => new Date(),
  logger = console,
  fs: fsApi = fs,
} = {}) {
  let acquiredRecord = null;

  async function acquire() {
    const record = { pid: processApi.pid, startedAt: now().toISOString() };
    await fsApi.mkdir(dirname(lockFile), { recursive: true, mode: 0o700 });

    let lastStale = false;
    let lastPreviousPid = null;
    const maxStaleRetries = 2;

    for (let staleRetries = 0; staleRetries <= maxStaleRetries; staleRetries += 1) {
      try {
        // mode は新規作成時だけ適用される。既存 lock は chmod せず、以後の作成既定だけ締める。
        await fsApi.writeFile(lockFile, JSON.stringify(record), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        acquiredRecord = record;

        return {
          acquired: true,
          stale: lastStale,
          previousPid: lastPreviousPid,
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }

      const existing = await readLock(lockFile, fsApi);
      if (existing?.pid != null && isProcessAlive(existing.pid, processApi)) {
        throw alreadyRunningError(existing);
      }

      lastStale = true;
      lastPreviousPid = existing?.pid ?? null;
      logger.warn?.(`[start-lock] stale lock を検出したため取得し直します (pid=${existing?.pid ?? 'unknown'}, startedAt=${existing?.startedAt ?? 'unknown'})`);

      if (staleRetries >= maxStaleRetries) {
        throw new Error('[start-lock] stale lock の再取得に失敗しました');
      }

      try {
        const current = await readLock(lockFile, fsApi);
        if (sameLockRecord(current, existing)) {
          await fsApi.unlink(lockFile);
        } else {
          throw alreadyRunningError(current);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }

    throw new Error('[start-lock] lock の取得に失敗しました');
  }

  async function release() {
    if (!acquiredRecord) return;

    try {
      const current = await readLock(lockFile, fsApi);
      if (
        current?.pid === acquiredRecord.pid &&
        current?.startedAt === acquiredRecord.startedAt
      ) {
        await fsApi.unlink(lockFile);
      }
    } catch {
      // 終了処理なので best effort。ロック削除失敗で終了を妨げない。
    } finally {
      acquiredRecord = null;
    }
  }

  function releaseSync() {
    if (!acquiredRecord) return;

    try {
      const text = nodeFs.readFileSync(lockFile, 'utf8');
      const current = JSON.parse(text);
      if (
        current?.pid === acquiredRecord.pid &&
        current?.startedAt === acquiredRecord.startedAt
      ) {
        nodeFs.unlinkSync(lockFile);
      }
    } catch {
      // 終了処理なので best effort。ロック削除失敗で終了を妨げない。
    } finally {
      acquiredRecord = null;
    }
  }

  return { acquire, release, releaseSync, lockFile };
}

async function readLock(lockFile, fsApi = fs) {
  try {
    const text = await fsApi.readFile(lockFile, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // 壊れた lock は stale と同等に扱って上書きできるようにする。
    return null;
  }
}

function alreadyRunningError(record) {
  return new Error(
    `[start-lock] vk-orchestrator は既に起動中です (pid=${record?.pid ?? 'unknown'}, startedAt=${record?.startedAt ?? 'unknown'}). ` +
    `終了してから再実行してください。`
  );
}

function sameLockRecord(current, expected) {
  if (current === null || expected === null) {
    return current === expected;
  }

  return (
    current.pid === expected.pid &&
    current.startedAt === expected.startedAt
  );
}

function isProcessAlive(pid, processApi) {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    processApi.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH はプロセス不在。EPERM は存在するが権限がない状態なので「生存」とみなす。
    if (err.code === 'ESRCH') return false;
    return true;
  }
}
