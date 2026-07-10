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
 * @param {(port:number)=>Promise<object>} [deps.getStates]
 * @param {number} deps.port
 * @param {object} [deps.logger=console]
 * @returns {(issueNumber:number|string, prUrl:string, logTag:string)=>Promise<void>}
 */
export function createNotifyPaneMerged({
  getTask,
  setTerminalPrUrl,
  getStates = null,
  port,
  logger = console,
}) {
  return async function notifyPaneMerged(issueNumber, prUrl, logTag) {
    let termId;
    try {
      termId = (await getTask(issueNumber))?.termId ?? null;
    } catch (err) {
      termId = null;
      logger.warn?.(`  ${logTag} issue #${issueNumber}: state から termId を取得できませんでした。prUrl=${prUrl} (${err.message})`);
    }
    if (termId == null) {
      logger.warn?.(`  ${logTag} issue #${issueNumber}: state に termId が無いため、prUrl から VK Terminals ペインを逆引きします。prUrl=${prUrl}`);
      termId = await findTermIdByPrUrl({ getStates, port, prUrl, issueNumber, logTag, logger });
      if (termId == null) return;
    }

    try {
      await setTerminalPrUrl(port, termId, prUrl, { prMerged: true });
      (logger.info ?? logger.log)?.(`  ${logTag} issue #${issueNumber}: VK Terminals へ prMerged を通知しました (termId=${termId}, prUrl=${prUrl})`);
    } catch (err) {
      logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals への prMerged 通知失敗（処理は継続）: ${err.message} (termId=${termId}, prUrl=${prUrl})`);
    }
  };
}

async function findTermIdByPrUrl({ getStates, port, prUrl, issueNumber, logTag, logger }) {
  if (typeof getStates !== 'function') {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: getStates が無いため prUrl 逆引きをスキップします。prUrl=${prUrl}`);
    return null;
  }

  let states;
  try {
    states = await getStates(port);
  } catch (err) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals states 取得失敗。prUrl 逆引きをスキップします。prUrl=${prUrl} (${err.message})`);
    return null;
  }

  const terminals = states?.terminals;
  if (!terminals || typeof terminals !== 'object') {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: VK Terminals states の形式が不正なため prUrl 逆引きできません。prUrl=${prUrl}`);
    return null;
  }

  const term = Object.values(terminals).find((pane) => {
    if (!pane || typeof pane !== 'object') return false;
    return pane.apiPrUrl === prUrl || pane.prUrl === prUrl;
  });
  if (!term?.termId) {
    logger.warn?.(`  ${logTag} issue #${issueNumber}: prUrl に一致する VK Terminals ペインが見つかりません。prUrl=${prUrl}`);
    return null;
  }

  return term.termId;
}
