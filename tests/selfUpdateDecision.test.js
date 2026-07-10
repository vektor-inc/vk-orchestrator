/**
 * orchestratorUpdateDecision のユニットテスト。
 *
 * vk-orchestrator 自身の自己更新は git / npm / re-exec の副作用を伴うため、
 * 更新してよいかどうかの判定だけを純粋関数として検証する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { orchestratorUpdateDecision } from '../src/engine/self-update.js';
import { cmpTuple, toTuple } from '../scripts/vk-terminals-tags.mjs';

const base = {
  current: '0.11.0',
  latest: 'v0.12.0',
  dirty: false,
  branch: 'main',
  optOut: false,
  alreadyUpdated: false,
};

describe('orchestratorUpdateDecision', () => {
  it('既に最新なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, latest: 'v0.11.0' }),
      { action: 'skip', reason: 'up-to-date' }
    );
  });

  it('ローカルが先行していても skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, current: '0.12.1', latest: 'v0.12.0' }),
      { action: 'skip', reason: 'up-to-date' }
    );
  });

  it('re-exec 後なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, alreadyUpdated: true }),
      { action: 'skip', reason: 'already-updated' }
    );
  });

  it('opt-out 指定なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, optOut: true }),
      { action: 'skip', reason: 'opt-out' }
    );
  });

  it('dirty なら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, dirty: true }),
      { action: 'skip', reason: 'dirty' }
    );
  });

  it('main 以外のブランチなら skip', () => {
    assert.deepEqual(
      orchestratorUpdateDecision({ ...base, branch: 'feature/test' }),
      { action: 'skip', reason: 'non-main-branch' }
    );
  });

  it('すべて満たすなら update', () => {
    assert.deepEqual(
      orchestratorUpdateDecision(base),
      { action: 'update', reason: 'newer-release' }
    );
  });
});

describe('semver tuple comparison', () => {
  it('等値は 0', () => {
    assert.equal(cmpTuple(toTuple('0.11.0'), toTuple('v0.11.0')), 0);
  });

  it('パッチ差を比較できる', () => {
    assert.ok(cmpTuple(toTuple('0.11.1'), toTuple('0.11.0')) > 0);
  });

  it('マイナー差を比較できる', () => {
    assert.ok(cmpTuple(toTuple('0.12.0'), toTuple('0.11.9')) > 0);
  });
});
