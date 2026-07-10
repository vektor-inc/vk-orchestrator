import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createScanInProgressMergedHandler } from '../src/engine/scan-in-progress-merged.js';

describe('scan-in-progress merged handler', () => {
  it('notifyPaneMerged を removeTask による termId 消込前に呼ぶ', async () => {
    const calls = [];
    const issue = { number: 85 };
    const pr = { html_url: 'https://github.com/vektor-inc/vk-orchestrator/pull/85' };
    const handleMerged = createScanInProgressMergedHandler({
      closeSourceIssueBeforeGate: async () => calls.push('closeSourceIssueBeforeGate'),
      canTransitionToDone: async () => {
        calls.push('canTransitionToDone');
        return true;
      },
      addComment: async () => calls.push('addComment'),
      closeIssue: async () => calls.push('closeIssue'),
      setStatus: async () => calls.push('setStatus'),
      notifyPaneMerged: async (...args) => calls.push(['notifyPaneMerged', ...args]),
      removeTask: async () => calls.push('removeTask'),
      logger: { log: () => {}, warn: () => {} },
    });

    const result = await handleMerged(issue, pr);

    assert.equal(result, true);
    assert.deepEqual(calls, [
      'closeSourceIssueBeforeGate',
      'canTransitionToDone',
      'addComment',
      'closeIssue',
      'setStatus',
      ['notifyPaneMerged', 85, pr.html_url, '[scan-in-progress]'],
      'removeTask',
    ]);
  });

  it('notifyPaneMerged の失敗は warn のみで握り、done 化を継続する', async () => {
    const calls = [];
    const warnings = [];
    const issue = { number: 86 };
    const pr = { html_url: 'https://github.com/vektor-inc/vk-orchestrator/pull/86' };
    const handleMerged = createScanInProgressMergedHandler({
      closeSourceIssueBeforeGate: async () => calls.push('closeSourceIssueBeforeGate'),
      canTransitionToDone: async () => {
        calls.push('canTransitionToDone');
        return true;
      },
      addComment: async () => calls.push('addComment'),
      closeIssue: async () => calls.push('closeIssue'),
      setStatus: async () => calls.push('setStatus'),
      notifyPaneMerged: async () => {
        calls.push('notifyPaneMerged');
        throw new Error('terminal unavailable');
      },
      removeTask: async () => calls.push('removeTask'),
      logger: { log: () => {}, warn: (message) => warnings.push(message) },
    });

    const result = await handleMerged(issue, pr);

    assert.equal(result, true);
    assert.deepEqual(calls, [
      'closeSourceIssueBeforeGate',
      'canTransitionToDone',
      'addComment',
      'closeIssue',
      'setStatus',
      'notifyPaneMerged',
      'removeTask',
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /issue #86/);
    assert.match(warnings[0], /terminal unavailable/);
  });
});
