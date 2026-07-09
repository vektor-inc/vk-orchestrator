/**
 * cleanupForIssue の wpPort=null 分岐のユニットテスト。
 *
 * 実 docker / git を叩く経路はこの環境では検証できないため、
 * docker 呼び出しに到達しないケース（wpPort も worktreePath も無い）だけを検証する。
 *
 * 検証観点:
 *   - wpPort も worktreePath も無いときもリモートブランチ削除は実行する
 *   - docker / ローカル worktree 掃除はスキップし、備考付きで安全に完了する
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupForIssue } from '../src/engine/cleanup.js';

describe('cleanupForIssue ガード', () => {
  it('wpPort も worktreePath も無いときもリモートブランチ削除を実行する', async () => {
    const deletedBranches = [];
    const summary = await cleanupForIssue({
      issueNumber: 99,
      wpPort: null,
      branch: 'feature/issue-99',
      worktreePath: null,
      deleteRemoteBranch: async (branch) => {
        deletedBranches.push(branch);
      },
    });

    assert.equal(summary.worktreeRemoved, false);
    assert.equal(summary.branchRemoved, false);
    assert.equal(summary.remoteBranchRemoved, true);
    assert.deepEqual(deletedBranches, ['feature/issue-99']);
    assert.equal(summary.containers.length, 0);
    assert.ok(
      summary.notes.some(n => n.includes('wpPort も worktree パスも未記録')),
      `想定の備考が見つからない: ${JSON.stringify(summary.notes)}`
    );
  });
});
