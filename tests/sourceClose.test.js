import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractGitHubIssueUrl } from '../src/engine/build-command.js';
import { closeSourceIssueBeforeGate } from '../src/engine/source-close.js';

describe('closeSourceIssueBeforeGate', () => {
  it('対象 issue URL があれば closeSourceIssue を呼ぶ', async () => {
    const calls = [];
    const result = await closeSourceIssueBeforeGate(
      {
        number: 10,
        title: '本体 issue 対応',
        body: 'https://github.com/vektor-inc/vk-terminals/issues/95',
      },
      {
        extractGitHubIssueUrl,
        closeSourceIssue: async (target) => {
          calls.push(target);
        },
      },
      { logger: { warn: () => {} } }
    );

    assert.equal(result, true);
    assert.deepEqual(calls, [
      {
        url: 'https://github.com/vektor-inc/vk-terminals/issues/95',
        owner: 'vektor-inc',
        repo: 'vk-terminals',
        number: 95,
      },
    ]);
  });

  it('直下 sub-issue が全て closed なら closeSourceIssue を呼ぶ', async () => {
    const calls = [];
    const result = await closeSourceIssueBeforeGate(
      {
        number: 20,
        title: '本体 issue 対応',
        body: 'https://github.com/vektor-inc/vk-terminals/issues/95',
      },
      {
        extractGitHubIssueUrl,
        getSubIssueStates: async (owner, repo, number) => {
          assert.equal(owner, 'vektor-inc');
          assert.equal(repo, 'vk-terminals');
          assert.equal(number, 95);
          return [
            { owner: 'vektor-inc', repo: 'vk-terminals', number: 101, state: 'closed' },
            { owner: 'vektor-inc', repo: 'other-repo', number: 5, state: 'closed' },
          ];
        },
        closeSourceIssue: async (target) => {
          calls.push(target);
        },
      },
      { logger: { warn: () => {} } }
    );

    assert.equal(result, true);
    assert.equal(calls.length, 1);
  });

  it('直下 sub-issue に open があれば closeSourceIssue を呼ばず false を返す', async () => {
    let called = false;
    const logs = [];
    const result = await closeSourceIssueBeforeGate(
      {
        number: 21,
        title: '本体 issue 対応',
        body: 'https://github.com/vektor-inc/vk-terminals/issues/95',
      },
      {
        extractGitHubIssueUrl,
        getSubIssueStates: async () => [
          { owner: 'vektor-inc', repo: 'vk-terminals', number: 101, state: 'open' },
        ],
        closeSourceIssue: async () => {
          called = true;
        },
      },
      {
        logTag: '[merge-watch]',
        logger: {
          log: (message) => logs.push(message),
          warn: () => {},
        },
      }
    );

    assert.equal(result, false);
    assert.equal(called, false);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /\[merge-watch\]/);
    assert.match(logs[0], /sub-issue が未完了/);
    assert.match(logs[0], /vektor-inc\/vk-terminals#101\(open\)/);
  });

  it('sub-issue 取得が throw したら closeSourceIssue を呼ばず false を返す', async () => {
    let called = false;
    const warnings = [];
    const result = await closeSourceIssueBeforeGate(
      {
        number: 22,
        title: '本体 issue 対応',
        body: 'https://github.com/vektor-inc/vk-terminals/issues/95',
      },
      {
        extractGitHubIssueUrl,
        getSubIssueStates: async () => {
          throw new Error('sub issue API failed');
        },
        closeSourceIssue: async () => {
          called = true;
        },
      },
      {
        logger: {
          warn: (message) => warnings.push(message),
        },
      }
    );

    assert.equal(result, false);
    assert.equal(called, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sub-issue 状態取得失敗/);
    assert.match(warnings[0], /sub issue API failed/);
  });

  it('sub-issue が0件なら従来どおり closeSourceIssue を呼ぶ', async () => {
    let called = false;
    const result = await closeSourceIssueBeforeGate(
      {
        number: 23,
        title: '本体 issue 対応',
        body: 'https://github.com/vektor-inc/vk-terminals/issues/95',
      },
      {
        extractGitHubIssueUrl,
        getSubIssueStates: async () => [],
        closeSourceIssue: async () => {
          called = true;
        },
      },
      { logger: { warn: () => {} } }
    );

    assert.equal(result, true);
    assert.equal(called, true);
  });

  it('対象 issue URL がなければ何もしない', async () => {
    let called = false;
    const result = await closeSourceIssueBeforeGate(
      { number: 11, title: '汎用タスク', body: 'URL なし' },
      {
        extractGitHubIssueUrl,
        closeSourceIssue: async () => {
          called = true;
        },
      },
      { logger: { warn: () => {} } }
    );

    assert.equal(result, false);
    assert.equal(called, false);
  });

  it('closeSourceIssue の失敗は warn のみで握る', async () => {
    const warnings = [];
    const result = await closeSourceIssueBeforeGate(
      {
        number: 12,
        title: '本体 issue 対応',
        body: 'https://github.com/vektor-inc/vk-terminals/issues/95',
      },
      {
        extractGitHubIssueUrl,
        closeSourceIssue: async () => {
          throw new Error('rate limit');
        },
      },
      {
        logTag: '[merge-watch]',
        logger: { warn: (message) => warnings.push(message) },
      }
    );

    assert.equal(result, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[merge-watch\]/);
    assert.match(warnings[0], /issue #12/);
    assert.match(warnings[0], /vektor-inc\/vk-terminals#95/);
    assert.match(warnings[0], /rate limit/);
  });
});
