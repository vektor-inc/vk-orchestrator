export function createWaitingMarkerScanner({
  fetchWaitingInputIssues,
  getStates,
  getTask,
  setExternalWaiting,
  port,
  logger = console,
}) {
  return async function scanWaitingMarkers() {
    let waitingIssues;
    try {
      waitingIssues = await fetchWaitingInputIssues();
    } catch (err) {
      logger.warn?.(`[scan-waiting-markers] waiting-input issue 取得失敗: ${err.message}`);
      return;
    }

    const waitingTermIds = [];
    for (const issue of waitingIssues) {
      let saved = null;
      try {
        saved = await getTask(issue.number);
      } catch (err) {
        logger.warn?.(`  [scan-waiting-markers] issue #${issue.number}: state 取得失敗: ${err.message}`);
        continue;
      }
      if (saved?.termId == null) continue;
      waitingTermIds.push(saved.termId);

      try {
        await setExternalWaiting(port, saved.termId, true);
      } catch (err) {
        logger.warn?.(`  [scan-waiting-markers] issue #${issue.number}: 入力待ちマーカー点灯失敗: ${err.message}`);
      }
    }

    let states;
    try {
      states = await getStates(port);
    } catch (err) {
      logger.warn?.(`[scan-waiting-markers] VK Terminals states 取得失敗: ${err.message}`);
      return;
    }

    const liveTermIds = collectLiveTermIds(states);
    const { off } = decideWaitingMarkers({ waitingTermIds, liveTermIds });
    for (const termId of off) {
      try {
        await setExternalWaiting(port, termId, false);
      } catch (err) {
        logger.warn?.(`  [scan-waiting-markers] termId=${termId}: 入力待ちマーカー消灯失敗: ${err.message}`);
      }
    }
  };
}

export function decideWaitingMarkers({ waitingTermIds = [], liveTermIds = [] } = {}) {
  const waitingSet = new Set(waitingTermIds.filter((termId) => termId != null).map((termId) => String(termId)));
  const on = uniqueTermIds(waitingTermIds);
  const off = uniqueTermIds(liveTermIds).filter((termId) => !waitingSet.has(String(termId)));
  return { on, off };
}

export function collectLiveTermIds(states) {
  const terminals = states?.terminals;
  if (!terminals || typeof terminals !== 'object') return [];
  return Object.values(terminals)
    .map((term) => term?.termId)
    .filter((termId) => termId != null);
}

function uniqueTermIds(termIds) {
  const seen = new Set();
  const unique = [];
  for (const termId of termIds) {
    if (termId == null) continue;
    const key = String(termId);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(termId);
  }
  return unique;
}
