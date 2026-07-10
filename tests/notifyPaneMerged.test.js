import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createNotifyPaneMerged } from '../src/engine/notify-pane-merged.js';

describe('notifyPaneMerged', () => {
  it('getTask が null の場合は warn を出し、getStates から prUrl 一致ペインを逆引きして prMerged を送る', async () => {
    const warnings = [];
    const infos = [];
    const calls = [];
    const prUrl = 'https://github.com/vektor-inc/example/pull/79';

    const notifyPaneMerged = createNotifyPaneMerged({
      port: 13847,
      getTask: async () => null,
      getStates: async () => ({
        terminals: {
          'pane-1': { termId: 'term-1', apiPrUrl: 'https://github.com/vektor-inc/example/pull/1' },
          'pane-2': { termId: 'term-2', apiPrUrl: prUrl },
        },
      }),
      setTerminalPrUrl: async (...args) => {
        calls.push(args);
        return { ok: true };
      },
      logger: {
        warn: (message) => warnings.push(message),
        info: (message) => infos.push(message),
      },
    });

    await notifyPaneMerged(79, prUrl, '[merge-watch]');

    assert.equal(calls.length, 1, 'prUrl 一致ペインへ通知する');
    assert.deepEqual(calls[0], [13847, 'term-2', prUrl, { prMerged: true }]);
    assert.equal(warnings.length, 1, 'termId を引けなかったことを warn する');
    assert.match(warnings[0], /issue #79/);
    assert.match(warnings[0], new RegExp(prUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(infos.length, 1, '送信成功を info ログに残す');
  });
});
