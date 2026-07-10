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
} = {}) {
  let acquiredRecord = null;

  async function acquire() {
    const existing = await readLock(lockFile);
    if (existing?.pid != null && isProcessAlive(existing.pid, processApi)) {
      throw new Error(
        `[start-lock] vk-orchestrator は既に起動中です (pid=${existing.pid}, startedAt=${existing.startedAt ?? 'unknown'}). ` +
        `終了してから再実行してください。`
      );
    }

    const stale = existing?.pid != null;
    if (stale) {
      logger.warn?.(`[start-lock] stale lock を検出したため取得し直します (pid=${existing.pid}, startedAt=${existing.startedAt ?? 'unknown'})`);
    }

    const record = { pid: processApi.pid, startedAt: now().toISOString() };
    await fs.mkdir(dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify(record), 'utf8');
    acquiredRecord = record;

    return {
      acquired: true,
      stale,
      previousPid: existing?.pid ?? null,
    };
  }

  async function release() {
    if (!acquiredRecord) return;

    try {
      const current = await readLock(lockFile);
      if (
        current?.pid === acquiredRecord.pid &&
        current?.startedAt === acquiredRecord.startedAt
      ) {
        await fs.unlink(lockFile);
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

async function readLock(lockFile) {
  try {
    const text = await fs.readFile(lockFile, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // 壊れた lock は stale と同等に扱って上書きできるようにする。
    return null;
  }
}

function isProcessAlive(pid, processApi) {
  try {
    processApi.kill(Number(pid), 0);
    return true;
  } catch (err) {
    // ESRCH はプロセス不在。EPERM は存在するが権限がない状態なので「生存」とみなす。
    if (err.code === 'ESRCH') return false;
    return true;
  }
}
