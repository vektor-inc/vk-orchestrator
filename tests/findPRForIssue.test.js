/**
 * findPRForIssue のフォールバック Search API 経路のユニットテスト。
 *
 * timeline events を常に空にして cross-referenced 候補を無くし、
 * 第二手の Search API フォールバックだけを検証する。
 * GitHub 全文検索は `${issueNumber}` を裸の数値トークンとして緩くマッチさせるため、
 * 本文に対象 issue URL への厳密一致参照を持つ PR だけに絞れているかを確認する
 * （task-queue#127 が無関係な PR #73 に誤マッチして自動 close された事故の回帰テスト）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';

const O = 'vektor-inc';
const R = 'task-queue';
const issueUrl = n => `https://github.com/${O}/${R}/issues/${n}`;
const prUrl = n => `https://github.com/${O}/${R}/pull/${n}`;

// timeline events なし（フォールバック検索経路のみ）の fake octokit を差し込む。
function makeClient(searchItems) {
  const client = new GitHubClient({ token: 'dummy', owner: O, repo: R });
  client.octokit = {
    paginate: async () => [], // listEventsForTimeline → cross-referenced 候補なし
    issues: { listEventsForTimeline: () => {} },
    pulls: { get: async () => { throw new Error('timeline 経路は通らないはず'); } },
    search: {
      issuesAndPullRequests: async () => ({ data: { items: searchItems } }),
    },
  };
  return client;
}

// timeline cross-referenced 候補ありの fake octokit。Search フォールバックは空にして
// timeline 経路の絞り込みだけを検証する。
function makeTimelineClient(events, prsByNumber, searchItems = []) {
  const client = new GitHubClient({ token: 'dummy', owner: O, repo: R });
  client.octokit = {
    paginate: async () => events,
    issues: { listEventsForTimeline: () => {} },
    pulls: {
      get: async ({ pull_number }) => {
        const pr = prsByNumber[pull_number];
        if (!pr) throw new Error(`未定義 PR #${pull_number}`);
        return { data: pr };
      },
    },
    search: {
      issuesAndPullRequests: async () => ({ data: { items: searchItems } }),
    },
  };
  return client;
}

// 同一 owner/repo の PR からの cross-referenced イベント。
const xref = n => ({
  event: 'cross-referenced',
  source: {
    type: 'issue',
    issue: { number: n, pull_request: {}, repository_url: `https://api.github.com/repos/${O}/${R}` },
  },
});

describe('findPRForIssue フォールバック検索の厳密一致', () => {
  it('番号だけ一致し対象 issue URL を含まない PR は拾わない（#127 誤 close 回帰）', async () => {
    const client = makeClient([
      // 本文に "127" を含むが /issues/127 への参照は無い無関係な merged PR
      { pull_request: {}, number: 73, state: 'closed', html_url: prUrl(73),
        body: 'ポート 13847 周りの修正。行 127 を変更。' },
    ]);
    const pr = await client.findPRForIssue(O, R, 127);
    assert.equal(pr, null, '番号一致だけの PR を誤マッチさせてはいけない');
  });

  it('本文に対象 issue URL を厳密に含む PR は返す', async () => {
    const client = makeClient([
      { pull_request: {}, number: 90, state: 'open', html_url: prUrl(90),
        body: `対応: ${issueUrl(127)}` },
    ]);
    const pr = await client.findPRForIssue(O, R, 127);
    assert.equal(pr?.number, 90);
  });

  it('/issues/127 を含む PR は issue #12 のフォールバックに誤ヒットしない（接頭辞一致回避）', async () => {
    const client = makeClient([
      { pull_request: {}, number: 91, state: 'open', html_url: prUrl(91),
        body: `対応: ${issueUrl(127)}` },
    ]);
    const pr = await client.findPRForIssue(O, R, 12);
    assert.equal(pr, null, '/issues/127 は /issues/12 にマッチしない');
  });

  it('厳密一致する PR が複数あれば OPEN を優先する', async () => {
    const client = makeClient([
      { pull_request: {}, number: 80, state: 'closed', html_url: prUrl(80), body: issueUrl(127) },
      { pull_request: {}, number: 81, state: 'open', html_url: prUrl(81), body: issueUrl(127) },
    ]);
    const pr = await client.findPRForIssue(O, R, 127);
    assert.equal(pr?.number, 81);
  });
});

describe('findPRForIssue timeline cross-reference の絞り込み', () => {
  it('本文で対象 issue を参照しない偶発 cross-ref は採用しない（#169→#134 誤紐付け回帰）', async () => {
    // PR #134 は #132 をコメントで言及しただけ（本文に URL もクローズキーワードも無い）。
    // updated_at が最新でも、対応 PR と誤認せず null を返さねばならない。
    const client = makeTimelineClient(
      [xref(134)],
      {
        134: {
          number: 134, state: 'closed', updated_at: '2026-06-16T07:11:27Z',
          html_url: prUrl(134), body: '別件 close #119。本文の132行目を変更。',
        },
      },
    );
    const pr = await client.findPRForIssue(O, R, 132);
    assert.equal(pr, null, '言及だけの PR を対応 PR と誤認してはいけない');
  });

  it('クローズキーワード + #N を本文に持つ PR は採用する', async () => {
    const client = makeTimelineClient(
      [xref(50)],
      { 50: { number: 50, state: 'open', updated_at: '2026-06-16T00:00:00Z', html_url: prUrl(50), body: 'Closes #132' } },
    );
    const pr = await client.findPRForIssue(O, R, 132);
    assert.equal(pr?.number, 50);
  });

  it('参照 PR に OPEN があれば updated_at が古くても OPEN を優先する', async () => {
    const client = makeTimelineClient(
      [xref(62), xref(63)],
      {
        62: { number: 62, state: 'open',   updated_at: '2026-06-10T00:00:00Z', html_url: prUrl(62), body: issueUrl(132) },
        63: { number: 63, state: 'closed', updated_at: '2026-06-16T00:00:00Z', html_url: prUrl(63), body: 'fixes #132' },
      },
    );
    const pr = await client.findPRForIssue(O, R, 132);
    assert.equal(pr?.number, 62, 'OPEN があれば updated_at 最新の closed より優先する');
  });

  it('参照 PR が全て closed なら updated_at 最新を返す', async () => {
    const client = makeTimelineClient(
      [xref(60), xref(61)],
      {
        60: { number: 60, state: 'closed', updated_at: '2026-06-10T00:00:00Z', html_url: prUrl(60), body: issueUrl(132) },
        61: { number: 61, state: 'closed', updated_at: '2026-06-15T00:00:00Z', html_url: prUrl(61), body: 'fixes #132' },
      },
    );
    const pr = await client.findPRForIssue(O, R, 132);
    assert.equal(pr?.number, 61, 'OPEN が無ければ参照 PR のうち最新更新を返す');
  });

  it('#132 は #1320 を close する PR に前方一致しない', async () => {
    const client = makeTimelineClient(
      [xref(70)],
      { 70: { number: 70, state: 'open', updated_at: '2026-06-16T00:00:00Z', html_url: prUrl(70), body: 'Closes #1320' } },
    );
    const pr = await client.findPRForIssue(O, R, 132);
    assert.equal(pr, null, '#1320 を #132 に誤マッチさせない');
  });
});
