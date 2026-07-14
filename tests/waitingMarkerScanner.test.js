import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createWaitingMarkerScanner,
  decideWaitingMarkers,
} from '../src/engine/waiting-marker-scanner.js';

describe('waitingMarkerScanner', () => {
  it('waiting-input 集合に居ない生存ペインは消灯する', async () => {
    const calls = [];
    const scanner = createWaitingMarkerScanner({
      port: 13847,
      fetchWaitingInputIssues: async () => [{ number: 101 }],
      getStates: async () => ({
        terminals: {
          'pane-1': { termId: 'term-waiting' },
          'pane-2': { termId: 'term-leftover' },
        },
      }),
      getTask: async (issueNumber) => {
        if (issueNumber === 101) return { termId: 'term-waiting' };
        return null;
      },
      setExternalWaiting: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
      logger: { warn: () => {} },
    });

    await scanner();

    assert.deepEqual(calls, [
      [13847, 'term-waiting', true],
      [13847, 'term-leftover', false],
    ]);
  });

  it('waiting-input issue の state 取得に失敗したら生存ペインを消灯しない', async () => {
    const calls = [];
    const scanner = createWaitingMarkerScanner({
      port: 13847,
      fetchWaitingInputIssues: async () => [{ number: 101 }, { number: 102 }],
      getStates: async () => ({
        terminals: {
          'pane-1': { termId: 'term-waiting' },
          'pane-2': { termId: 'term-leftover' },
        },
      }),
      getTask: async (issueNumber) => {
        if (issueNumber === 101) return { termId: 'term-waiting' };
        throw new Error('temporary failure');
      },
      setExternalWaiting: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
      logger: { warn: () => {} },
    });

    await scanner();

    assert.deepEqual(calls, [
      [13847, 'term-waiting', true],
    ]);
  });

  it('waiting-input issue の termId が null なら生存ペインを消灯しない', async () => {
    const calls = [];
    const scanner = createWaitingMarkerScanner({
      port: 13847,
      fetchWaitingInputIssues: async () => [{ number: 101 }, { number: 102 }],
      getStates: async () => ({
        terminals: {
          'pane-1': { termId: 'term-waiting' },
          'pane-2': { termId: 'term-leftover' },
        },
      }),
      getTask: async (issueNumber) => {
        if (issueNumber === 101) return { termId: 'term-waiting' };
        return { termId: null };
      },
      setExternalWaiting: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
      logger: { warn: () => {} },
    });

    await scanner();

    assert.deepEqual(calls, [
      [13847, 'term-waiting', true],
    ]);
  });

  it('消灯対象は waiting-input 集合に居ない生存ペインだけにする', () => {
    const result = decideWaitingMarkers({
      waitingTermIds: ['term-1', 'term-1', 2],
      liveTermIds: ['term-1', '2', 'term-3', 'term-3', null],
    });

    assert.deepEqual(result, {
      on: ['term-1', 2],
      off: ['term-3'],
    });
  });
});
