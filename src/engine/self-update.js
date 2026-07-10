/**
 * vk-orchestrator 自身の自己更新可否を決める純粋関数。
 *
 * 実際の git / npm / re-exec は CLI 側で行い、このモジュールは
 * package.json の version とリモート最新タグ、作業ツリー状態だけから判断する。
 */

import { cmpTuple, toTuple } from '../../scripts/vk-terminals-tags.mjs';

/**
 * @param {object} input
 * @param {string|null} [input.current] package.json の現在 version
 * @param {string|null} [input.latest] リモート最新 semver タグ
 * @param {boolean} [input.dirty] 未コミット変更があるか
 * @param {string} [input.branch] 現在のブランチ名
 * @param {boolean} [input.optOut] 自己更新を無効化しているか
 * @param {boolean} [input.alreadyUpdated] re-exec 後の再チェックか
 * @returns {{ action: 'update'|'skip', reason: string }}
 */
export function orchestratorUpdateDecision({
  current = null,
  latest = null,
  dirty = false,
  branch = '',
  optOut = false,
  alreadyUpdated = false,
} = {}) {
  if (alreadyUpdated) return { action: 'skip', reason: 'already-updated' };
  if (optOut) return { action: 'skip', reason: 'opt-out' };
  if (!current || !latest) return { action: 'skip', reason: 'version-unresolved' };

  const currentTuple = toTuple(current);
  const latestTuple = toTuple(latest);
  if (!currentTuple || !latestTuple) return { action: 'skip', reason: 'invalid-version' };
  if (cmpTuple(latestTuple, currentTuple) <= 0) return { action: 'skip', reason: 'up-to-date' };

  if (dirty) return { action: 'skip', reason: 'dirty' };
  if (branch !== 'main') return { action: 'skip', reason: 'non-main-branch' };

  return { action: 'update', reason: 'newer-release' };
}
