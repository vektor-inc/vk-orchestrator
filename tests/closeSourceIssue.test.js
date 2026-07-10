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
