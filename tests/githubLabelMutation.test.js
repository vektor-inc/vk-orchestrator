import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';

function makeClient(labels) {
  const calls = [];
  const client = new GitHubClient({ token: 'dummy', owner: 'vektor-inc', repo: 'task-queue' });
  client.octokit = {
    issues: {
      get: async (params) => {
        calls.push(['get', params]);
        return { data: { labels } };
      },
      setLabels: async (params) => {
        calls.push(['setLabels', params]);
        return { data: {} };
      },
    },
  };
  return { client, calls };
}

describe('GitHubClient label mutations', () => {
  it('setPriority: priority:* だけを差し替え、他のラベルを温存する', async () => {
    const { client, calls } = makeClient([
      { name: 'status:ready' },
      { name: 'priority:low' },
      { name: 'sequential' },
      { name: 'automerge' },
    ]);

    await client.setPriority(146, 'high');

    assert.deepEqual(calls.at(-1), ['setLabels', {
      owner: 'vektor-inc',
      repo: 'task-queue',
      issue_number: 146,
      labels: ['status:ready', 'sequential', 'automerge', 'priority:high'],
    }]);
  });

  it('setPriority: none は priority:* を外すだけで他のラベルを温存する', async () => {
    const { client, calls } = makeClient([
      { name: 'status:waiting-input' },
      { name: 'priority:medium' },
      { name: 'automerge' },
    ]);

    await client.setPriority(147, 'none');

    assert.deepEqual(calls.at(-1)[1].labels, ['status:waiting-input', 'automerge']);
  });

  it('setSequential: sequential だけを差し替え、status/priority を温存する', async () => {
    const { client, calls } = makeClient([
      { name: 'status:ready' },
      { name: 'priority:high' },
      { name: 'automerge' },
    ]);

    await client.setSequential(148, 'sequential');

    assert.deepEqual(calls.at(-1)[1].labels, [
      'status:ready',
      'priority:high',
      'automerge',
      'sequential',
    ]);
  });

  it('setSequential: parallel は sequential を外すだけで parallel ラベルを付けない', async () => {
    const { client, calls } = makeClient([
      { name: 'status:ready' },
      { name: 'priority:low' },
      { name: 'sequential' },
    ]);

    await client.setSequential(149, 'parallel');

    assert.deepEqual(calls.at(-1)[1].labels, ['status:ready', 'priority:low']);
  });
});
