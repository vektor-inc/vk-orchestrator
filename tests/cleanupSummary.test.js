/**
 * formatCleanupSummary のユニットテスト。
 *
 * マージ後クリーンアップ（automerge / 外部マージ）と pane 消失リカバリーで共用する
 * サマリ整形の純粋関数を検証する。
 *
 * 検証観点:
 *   - wp-env ポート / worktree / ブランチ / コンテナ / 備考の各行が状態に応じて出る
 *   - branch を指定した automerge 後のサマリにブランチ行（削除/残存）が出る
 *   - branch 未指定（pane 消失リカバリー）ではブランチ行を出さない
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatCleanupSummary } from '../src/engine/cleanup.js';

describe('formatCleanupSummary', () => {
  it('automerge 後: worktree とブランチをともに削除したサマリ', () => {
    const out = formatCleanupSummary({
      wpPort: 8920,
      containers: ['wp', 'tests-wp', 'mysql'],
      worktreePath: '/repo/.claude/worktrees/issue-12',
      containersRemoved: 3,
      volumesRemoved: 2,
      networksRemoved: 1,
      worktreeRemoved: true,
      branch: 'feature/issue-12',
      branchRemoved: true,
      notes: [],
    });
    assert.match(out, /wp-env ポート: `8920`/);
    assert.match(out, /worktree: `\/repo\/\.claude\/worktrees\/issue-12` → 削除/);
    assert.match(out, /ブランチ: `feature\/issue-12` → 削除/);
    assert.match(out, /検出コンテナ: 3 個/);
  });

  it('ブランチ削除に失敗したら残存表示になる', () => {
    const out = formatCleanupSummary({
      wpPort: 8920,
      containers: [],
      worktreePath: '/repo/.claude/worktrees/issue-12',
      containersRemoved: 0,
      volumesRemoved: 0,
      networksRemoved: 0,
      worktreeRemoved: true,
      branch: 'feature/issue-12',
      branchRemoved: false,
      notes: ['ブランチ削除失敗 (feature/issue-12): error'],
    });
    assert.match(out, /ブランチ: `feature\/issue-12` → 残存/);
    assert.match(out, /備考: ブランチ削除失敗/);
  });

  it('branch 未指定（pane 消失リカバリー）ではブランチ行を出さない', () => {
    const out = formatCleanupSummary({
      wpPort: 8920,
      containers: ['wp'],
      worktreePath: '/repo/.claude/worktrees/issue-12',
      containersRemoved: 1,
      volumesRemoved: 0,
      networksRemoved: 0,
      worktreeRemoved: true,
      branch: null,
      branchRemoved: false,
      notes: [],
    });
    assert.doesNotMatch(out, /ブランチ:/);
  });
});
