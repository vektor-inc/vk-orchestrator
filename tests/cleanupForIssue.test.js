/**
 * cleanupForIssue のガード分岐のユニットテスト。
 *
 * 実 docker / git を叩く経路はこの環境では検証できないため、
 * docker 呼び出しに到達しないケース（wpPort も worktreePath も無い）だけを検証する。
 *
 * 検証観点:
 *   - wpPort も worktreePath も無いときは docker を呼ばず、備考付きで安全に return する
 *   - その際 worktree・ブランチ削除は実行されない（summary は初期値のまま）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupForIssue } from '../src/engine/cleanup.js';

describe('cleanupForIssue ガード', () => {
  it('wpPort も worktreePath も無いと docker を呼ばず備考付きで return する', async () => {
    const summary = await cleanupForIssue({
      issueNumber: 99,
      wpPort: null,
      branch: 'feature/issue-99',
      worktreePath: null,
    });

    assert.equal(summary.worktreeRemoved, false);
    assert.equal(summary.branchRemoved, false);
    assert.equal(summary.containers.length, 0);
    assert.ok(
      summary.notes.some(n => n.includes('掃除対象を特定できず')),
      `想定の備考が見つからない: ${JSON.stringify(summary.notes)}`
    );
  });
});
