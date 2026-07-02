/**
 * decideInProgressAction（orchestrator/in-progress-decision.js）のユニットテスト。
 *
 * 対象 issue/PR のコメント・PR 状態・PR 完了可否の組合せから、
 * in-progress issue の次状態遷移が期待どおりかを検証する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideInProgressAction } from '../src/engine/in-progress-decision.js';

const agentWaitingInput = ['Comment by vk-agents', 'Status: waiting-input', '', '確認お願いします'].join('\n');
const agentAnswered = ['Comment by vk-agents', 'Status: answered', '', 'ペイン経由で解決済みです'].join('\n');
const userReply = 'A 案で進めてください';

describe('decideInProgressAction', () => {
  it('未応答の waiting-input があれば waiting-input（PR 状態より優先）', () => {
    const r = decideInProgressAction({
      comments: [{ body: agentWaitingInput }],
      pr: { state: 'open', merged: false },
      prCompletionReady: true,
    });
    assert.equal(r.type, 'waiting-input');
  });

  it('PR マージ済みなら merged', () => {
    const r = decideInProgressAction({
      comments: [{ body: agentWaitingInput }, { body: userReply }],
      pr: { state: 'closed', merged: true },
    });
    assert.equal(r.type, 'merged');
  });

  it('PR が未マージ closed なら pr-closed-unmerged', () => {
    const r = decideInProgressAction({
      comments: [],
      pr: { state: 'closed', merged: false },
    });
    assert.equal(r.type, 'pr-closed-unmerged');
  });

  it('open PR で完了条件を満たせば waiting-merge', () => {
    const r = decideInProgressAction({
      comments: [],
      pr: { state: 'open', merged: false },
      prCompletionReady: true,
    });
    assert.equal(r.type, 'waiting-merge');
  });

  it('open PR で完了条件を満たさなければ none（作業継続）', () => {
    const r = decideInProgressAction({
      comments: [],
      pr: { state: 'open', merged: false },
      prCompletionReady: false,
    });
    assert.equal(r.type, 'none');
  });

  it('PR がまだ無ければ none', () => {
    const r = decideInProgressAction({ comments: [], pr: null });
    assert.equal(r.type, 'none');
  });

  it('応答済みの waiting-input は waiting-input にしない（PR 評価に進む）', () => {
    const r = decideInProgressAction({
      comments: [{ body: agentWaitingInput }, { body: userReply }],
      pr: { state: 'open', merged: false },
      prCompletionReady: true,
    });
    assert.equal(r.type, 'waiting-merge');
  });

  it('エージェント発 answered で pending 解除済み（PR 無し）なら none（waiting-input に戻さない）', () => {
    // 司がペイン経由で解決して Status: answered を出した後、scanWaitingInputIssues が
    // in-progress に復帰させる。その直後の scanInProgress が即 waiting-input に戻さないこと。
    const r = decideInProgressAction({
      comments: [{ body: agentWaitingInput }, { body: agentAnswered }],
      pr: null,
    });
    assert.equal(r.type, 'none');
  });

  it('引数なしでも安全に none', () => {
    assert.equal(decideInProgressAction().type, 'none');
  });

  describe('automerge ラベルとの相互作用', () => {
    it('automerge + 完了条件充足の open PR では、未応答 waiting-input を override して waiting-merge', () => {
      // 司の「マージ判断お願いします」waiting-input で自動マージが止まらないこと。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
        automerge: true,
      });
      assert.equal(r.type, 'waiting-merge');
    });

    it('automerge + マージ済み PR では、未応答 waiting-input を override して merged', () => {
      // 司が手動マージ済みでも、マージ判断依頼コメントで done 化が止まらないこと。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'closed', merged: true },
        automerge: true,
      });
      assert.equal(r.type, 'merged');
    });

    it('automerge でも PR が未完了なら waiting-input は override せず waiting-input（本物の判断待ち）', () => {
      // automerge が事前承認するのはマージ手順だけ。実装途中の仕様確認は従来どおり止める。
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'open', merged: false },
        prCompletionReady: false,
        automerge: true,
      });
      assert.equal(r.type, 'waiting-input');
    });

    it('automerge でも PR がまだ無ければ waiting-input は override せず waiting-input', () => {
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: null,
        automerge: true,
      });
      assert.equal(r.type, 'waiting-input');
    });

    it('automerge なし（既定）では完了条件充足でも waiting-input が優先され waiting-input（従来挙動を維持）', () => {
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
        // automerge 未指定
      });
      assert.equal(r.type, 'waiting-input');
    });

    it('automerge + 完了条件充足でも、waiting-input が応答済みなら通常どおり waiting-merge', () => {
      const r = decideInProgressAction({
        comments: [{ body: agentWaitingInput }, { body: userReply }],
        pr: { state: 'open', merged: false },
        prCompletionReady: true,
        automerge: true,
      });
      assert.equal(r.type, 'waiting-merge');
    });
  });
});
