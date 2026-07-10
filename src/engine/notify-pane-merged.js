// -------------------------------------------------------
// PR マージ済み表示の VK Terminals 通知
//
// 本流の close / cleanup を止めるほど重要ではないため、通知失敗は warn で握る。
// 依存関数は呼び出し側から注入し、ユニットテストで実 state / 実 VK Terminals API を
// 叩かずに分岐を検証できるようにしている。
// -------------------------------------------------------

/**
 * @param {object} deps
 * @param {(issueNumber:number|string)=>Promise<object|null>} deps.getTask
 * @param {(port:number, termId:string|number, prUrl:string, options?:object)=>Promise<object>} deps.setTerminalPrUrl
 * @param {number} deps.port
 * @param {object} [deps.logger=console]
 * @returns {(issueNumber:number|string, prUrl:string, logTag:string)=>Promise<void>}
 */
export function createNotifyPaneMerged({
  getTask,
  setTerminalPrUrl,
  port,
  logger = console,
}) {
  return async function notifyPaneMerged(issueNumber, prUrl, logTag) {
    let termId;
    try {
      termId = (await getTask(issueNumber))?.termId ?? null;
    } catch {
      termId = null;
    }
    if (termId == null) return;

    try {
      await setTerminalPrUrl(port, termId, prUrl, { prMerged: true });
    } catch (err) {
      logger.warn?.(`  ${logTag} VK Terminals への prMerged 通知失敗（処理は継続）: ${err.message}`);
    }
  };
}
