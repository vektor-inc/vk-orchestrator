import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';

describe('closeSourceIssue', () => {
  it('明示 owner/repo/number の issue を close する', async () => {
    const calls = [];
    const client = new GitHubClient({ token: 'dummy', owner: 'vektor-inc', repo: 'task-queue' });
    client.octokit = {
      issues: {
        update: async (params) => {
          calls.push(params);
          return { data: {} };
        },
      },
    };

    await client.closeSourceIssue({ owner: 'vektor-inc', repo: 'vk-terminals', number: 95 });

    assert.deepEqual(calls, [
      {
        owner: 'vektor-inc',
        repo: 'vk-terminals',
        issue_number: 95,
        state: 'closed',
      },
    ]);
  });
});

describe('listSubIssueStates', () => {
  it('paginate で sub-issue を全件取得し repository_url から owner/repo を返す', async () => {
    const listSubIssues = () => {};
    const client = new GitHubClient({ token: 'dummy', owner: 'vektor-inc', repo: 'task-queue' });
    client.octokit = {
      paginate: async (method, params) => {
        assert.equal(method, listSubIssues);
        assert.deepEqual(params, {
          owner: 'vektor-inc',
          repo: 'parent-repo',
          issue_number: 103,
          per_page: 100,
        });
        return [
          {
            repository_url: 'https://api.github.com/repos/vektor-inc/repo-a',
            number: 10,
            state: 'closed',
          },
          {
            repository_url: 'https://api.github.com/repos/another-owner/repo-b',
            number: 20,
            state: 'open',
          },
        ];
      },
      issues: { listSubIssues },
    };

    const result = await client.listSubIssueStates('vektor-inc', 'parent-repo', 103);

    assert.deepEqual(result, [
      { owner: 'vektor-inc', repo: 'repo-a', number: 10, state: 'closed' },
      { owner: 'another-owner', repo: 'repo-b', number: 20, state: 'open' },
    ]);
  });

  it('sub-issue が0件なら空配列を返す', async () => {
    const client = new GitHubClient({ token: 'dummy', owner: 'vektor-inc', repo: 'task-queue' });
    client.octokit = {
      paginate: async () => [],
      issues: { listSubIssues: () => {} },
    };

    const result = await client.listSubIssueStates('vektor-inc', 'parent-repo', 103);

    assert.deepEqual(result, []);
  });
});
