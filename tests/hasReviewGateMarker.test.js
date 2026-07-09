/**
 * hasReviewGateMarker のユニットテスト。
 *
 * automerge のエージェントレビュー完了ゲートで使う判定。
 * マーカー = 'agent-review-passed' ラベル + 「agent-review-passed-sha: <sha>」コメント（現 head SHA と前方一致）。
 * ラベルと SHA 一致コメントの両方が揃ったときだけ true（安全側：マーカー無し → マージしない）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';

const O = 'vektor-inc';
const R = 'task-queue';

// pulls.get の labels と issues.listComments（paginate 経由）を差し込む fake octokit。
function makeClient({ labels = [], comments = [] } = {}) {
  const client = new GitHubClient({ token: 'dummy', owner: O, repo: R });
  client.octokit = {
    pulls: {
      get: async () => ({ data: { labels: labels.map(name => ({ name })) } }),
    },
    issues: {
      // paginate に渡される関数（呼び出されないが整合のため定義）
      listComments: () => {},
    },
    // paginate は全件配列を返す前提なので、コメント配列をそのまま返す。
    // comments 要素は文字列（投稿者は信頼境界内 = MEMBER 既定）か
    // { body, author_association } オブジェクトのどちらでも受け付ける。
    paginate: async () =>
      comments.map(c =>
        typeof c === 'string'
          ? { body: c, author_association: 'MEMBER' }
          : { author_association: 'MEMBER', ...c }
      ),
  };
  return client;
}

describe('hasReviewGateMarker', () => {
  it('(a) ラベルあり + SHA 一致コメントあり → true', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: [`レビュー確認完了しました。\nagent-review-passed-sha: ${sha}`],
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, sha), true);
  });

  it('(b) ラベル無し → false（コメントが一致していても）', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: [],
      comments: [`agent-review-passed-sha: ${sha}`],
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, sha), false);
  });

  it('(c) ラベルあり + SHA 不一致コメント → false', async () => {
    const headSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const otherSha = '0000000111111112222222333333344444445555';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: [`agent-review-passed-sha: ${otherSha}`],
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, headSha), false);
  });

  it('(d) ラベルあり + コメント無し → false', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: [],
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, sha), false);
  });

  it('(e) 短縮 SHA の前方一致 → true', async () => {
    const headSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: ['agent-review-passed-sha: abcdef1'], // 7 桁短縮 SHA
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, headSha), true);
  });

  it('短縮 SHA でも別コミットには前方一致しない → false', async () => {
    const headSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: ['agent-review-passed-sha: abcde99'], // head とは異なる短縮 SHA
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, headSha), false);
  });

  it('大文字混じりの SHA コメントでも前方一致する（正規表現 /i・lowercase 正規化）', async () => {
    const headSha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: ['agent-review-passed-sha: ABCDEF1'],
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, headSha), true);
  });

  it('SHA は一致するが信頼境界外（author_association: NONE）の投稿者なら無視 → false（偽装防止）', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: [{ body: `agent-review-passed-sha: ${sha}`, author_association: 'NONE' }],
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, sha), false);
  });

  it('CONTRIBUTOR の SHA コメントは無視するが、信頼境界内の一致コメントが別にあれば true', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: [
        { body: `agent-review-passed-sha: ${sha}`, author_association: 'CONTRIBUTOR' },
        { body: `agent-review-passed-sha: ${sha}`, author_association: 'OWNER' },
      ],
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, sha), true);
  });

  it('COLLABORATOR の一致コメントは信頼境界内として true', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const client = makeClient({
      labels: ['agent-review-passed'],
      comments: [{ body: `agent-review-passed-sha: ${sha}`, author_association: 'COLLABORATOR' }],
    });
    assert.equal(await client.hasReviewGateMarker(O, R, 10, sha), true);
  });
});
