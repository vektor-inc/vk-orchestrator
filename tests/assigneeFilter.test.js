import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';

const owner = 'vektor-inc';
const repo = 'task-queue';

function makeClient(assignee) {
  return new GitHubClient({ token: 'dummy', owner, repo, assignee });
}

describe('GitHubClient assignee filter', () => {
  it('assignee: null は pickup を無効化し、候補列挙 API を呼ばずに空配列を返す', async () => {
    const client = makeClient(null);
    client.octokit = {
      issues: {
        listForRepo: async () => {
          throw new Error('listForRepo should not be called');
        },
      },
      paginate: async () => {
        throw new Error('paginate should not be called');
      },
      search: {
        issuesAndPullRequests: async () => {
          throw new Error('search should not be called');
        },
      },
    };

    assert.equal(client.pickupEnabled, false);
    assert.deepEqual(await client.fetchPendingIssues(), []);
    assert.deepEqual(await client.fetchStuckIssues(), []);
    assert.deepEqual(await client.searchSourceIssuesByLabel('vektor-inc', 'task-queue'), []);
  });

  it('assignee: all は全件モードになり、assignee 条件なしで候補を取得する', async () => {
    const client = makeClient('all');
    let listForRepoParams;
    const issues = [
      { number: 2, labels: [{ name: 'priority:high' }] },
      { number: 1, labels: [] },
    ];
    client.octokit = {
      issues: {
        listForRepo: async (params) => {
          listForRepoParams = params;
          return { data: issues };
        },
      },
    };

    assert.equal(client.pickupEnabled, true);
    assert.deepEqual(client.assigneeQuery(), {});
    assert.deepEqual(await client.fetchPendingIssues(), issues);
    assert.equal(Object.hasOwn(listForRepoParams, 'assignee'), false);
  });

  it('assignee: ALL は全件モードとして扱う', () => {
    const client = makeClient('ALL');

    assert.equal(client.pickupEnabled, true);
    assert.deepEqual(client.assigneeQuery(), {});
  });

  it('assignee: "  all  " は trim して全件モードとして扱う', () => {
    const client = makeClient('  all  ');

    assert.equal(client.pickupEnabled, true);
    assert.deepEqual(client.assigneeQuery(), {});
  });

  it('assignee: 空白のみは pickup を無効化する', () => {
    const client = makeClient('   ');

    assert.equal(client.pickupEnabled, false);
    assert.deepEqual(client.assigneeQuery(), {});
  });

  it('assignee: alice は担当者フィルタとして扱う', () => {
    const client = makeClient('alice');

    assert.equal(client.pickupEnabled, true);
    assert.deepEqual(client.assigneeQuery(), { assignee: 'alice' });
  });
});
