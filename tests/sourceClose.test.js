import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { closeSourceIssueBeforeGate } from '../src/engine/source-close.js';

function fakeExtractGitHubIssueUrl(text) {
  if (!text) return null;
  const match = text.match(
    /https:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)\/issues\/(\d+)/
  );
  if (!match) return null;
  return { url: match[0], owner: match[1], repo: match[2], number: Number(match[3]) };
}

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
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
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

  it('対象 issue URL がなければ何もしない', async () => {
    let called = false;
    const result = await closeSourceIssueBeforeGate(
      { number: 11, title: '汎用タスク', body: 'URL なし' },
      {
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
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
        extractGitHubIssueUrl: fakeExtractGitHubIssueUrl,
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
