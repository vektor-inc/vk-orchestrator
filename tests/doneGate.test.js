/**
 * canTransitionToDone のユニットテスト。
 *
 * 依存注入経由で `extractGitHubIssueUrl` と `getIssueState` の fake を渡し、
 * 対象 issue の state（open / closed / 取得失敗）と本文に対象 URL があるかどうかの
 * 組合せで done 遷移ゲートの真偽が期待通りかを検証する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { canTransitionToDone } from '../src/engine/done-gate.js';

// index.js の同名関数と挙動を揃えた fake。
function fakeExtractGitHubIssueUrl(text) {
  if (!text) return null;
  const match = text.match(
    /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/
  );
  if (!match) return null;
  return { url: match[0], owner: match[1], repo: match[2], number: Number(match[3]) };
}

// console.log / warn を黙らせるためのスタブ
const silentLogger = { log: () => {}, warn: () => {} };

describe('canTransitionToDone', () => {
  it('本文に対象 issue URL が無い場合は getIssueState を呼ばずに true を返す', async () => {
    let called = false;
    const result = await canTransitionToDone(
      {
        number: 1,
        title: '汎用タスク',
        body: '対象 URL なしの本文',
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async () => {
          called = true;
          return { state: 'open' };
        },
      },
      { logger: silentLogger }
    );

    assert.equal(result, true);
    assert.equal(called, false, '対象 URL が無ければ API を叩かない');
  });

  it('対象 issue が closed なら true を返す', async () => {
    const result = await canTransitionToDone(
      {
        number: 10,
        title: '#42 を対応',
        body: 'https://github.com/owner/repo/issues/42 を fix する',
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async (owner, repo, number) => {
          assert.equal(owner, 'owner');
          assert.equal(repo, 'repo');
          assert.equal(number, 42);
          return { state: 'closed', closedAt: '2026-05-16T00:00:00Z' };
        },
      },
      { logger: silentLogger }
    );

    assert.equal(result, true);
  });

  it('対象 issue と直下 sub-issue が全て closed なら true を返す', async () => {
    const result = await canTransitionToDone(
      {
        number: 101,
        title: '複数 PR タスク',
        body: 'https://github.com/owner/repo/issues/42',
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async () => ({ state: 'closed' }),
        getSubIssueStates: async (owner, repo, number) => {
          assert.equal(owner, 'owner');
          assert.equal(repo, 'repo');
          assert.equal(number, 42);
          return [
            { owner: 'owner', repo: 'repo-a', number: 1, state: 'closed' },
            { owner: 'another-owner', repo: 'repo-b', number: 2, state: 'closed' },
          ];
        },
      },
      { logger: silentLogger }
    );

    assert.equal(result, true);
  });

  it('対象 issue が closed でも直下 sub-issue に open があれば false を返す', async () => {
    const logs = [];
    const result = await canTransitionToDone(
      {
        number: 102,
        title: '複数 PR タスク',
        body: 'https://github.com/owner/repo/issues/42',
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async () => ({ state: 'closed' }),
        getSubIssueStates: async () => [
          { owner: 'owner', repo: 'repo-a', number: 1, state: 'closed' },
          { owner: 'owner', repo: 'repo-b', number: 2, state: 'open' },
        ],
      },
      {
        logTag: '[merge-watch]',
        logger: {
          log: (msg) => logs.push(['log', msg]),
          warn: (msg) => logs.push(['warn', msg]),
        },
      }
    );

    assert.equal(result, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'log');
    assert.match(logs[0][1], /\[merge-watch\]/);
    assert.match(logs[0][1], /sub-issue が未完了/);
    assert.match(logs[0][1], /owner\/repo-b#2\(open\)/);
  });

  it('sub-issue 取得が throw したら安全側に倒して false を返す', async () => {
    const logs = [];
    const result = await canTransitionToDone(
      {
        number: 103,
        title: '複数 PR タスク',
        body: 'https://github.com/owner/repo/issues/42',
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async () => ({ state: 'closed' }),
        getSubIssueStates: async () => {
          throw new Error('sub issue API failed');
        },
      },
      {
        logger: {
          log: (msg) => logs.push(['log', msg]),
          warn: (msg) => logs.push(['warn', msg]),
        },
      }
    );

    assert.equal(result, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.match(logs[0][1], /sub-issue 状態取得失敗/);
    assert.match(logs[0][1], /sub issue API failed/);
  });

  it('sub-issue が0件なら従来どおり親 issue の closed のみで true を返す', async () => {
    const result = await canTransitionToDone(
      {
        number: 104,
        title: '単一 PR タスク',
        body: 'https://github.com/owner/repo/issues/42',
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async () => ({ state: 'closed' }),
        getSubIssueStates: async () => [],
      },
      { logger: silentLogger }
    );

    assert.equal(result, true);
  });

  it('対象 issue が open なら false を返す（部分対応マージ対策）', async () => {
    // task-queue#49 と同じ状況: 対象 issue は open のまま PR だけマージされたケース。
    const logs = [];
    const result = await canTransitionToDone(
      {
        number: 49,
        title: 'vk-all-in-one-expansion-unit#1342 を対応',
        body: '対象 issue: https://github.com/vektor-inc/vk-all-in-one-expansion-unit/issues/1342',
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async () => ({ state: 'open' }),
      },
      {
        logTag: '[in-progress-watch]',
        logger: {
          log: (msg) => logs.push(['log', msg]),
          warn: (msg) => logs.push(['warn', msg]),
        },
      }
    );

    assert.equal(result, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'log');
    assert.match(logs[0][1], /\[in-progress-watch\]/);
    assert.match(logs[0][1], /issue #49/);
    assert.match(logs[0][1], /open のため done への遷移を見送り/);
  });

  it('getIssueState が throw したら安全側に倒して false を返す', async () => {
    const logs = [];
    const result = await canTransitionToDone(
      {
        number: 50,
        title: 'API 失敗を確認',
        body: 'https://github.com/owner/repo/issues/99',
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async () => {
          const err = new Error('rate limit');
          err.status = 429;
          throw err;
        },
      },
      {
        logTag: '[merge-watch]',
        logger: {
          log: (msg) => logs.push(['log', msg]),
          warn: (msg) => logs.push(['warn', msg]),
        },
      }
    );

    assert.equal(result, false);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'warn');
    assert.match(logs[0][1], /\[merge-watch\]/);
    assert.match(logs[0][1], /状態取得失敗/);
    assert.match(logs[0][1], /rate limit/);
  });

  it('title に対象 URL があり body が空でも検出する', async () => {
    const result = await canTransitionToDone(
      {
        number: 11,
        title: 'https://github.com/owner/repo/issues/7 を対応',
        body: null,
      },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
        getIssueState: async (owner, repo, number) => {
          assert.equal(number, 7);
          return { state: 'closed' };
        },
      },
      { logger: silentLogger }
    );

    assert.equal(result, true);
  });
});
