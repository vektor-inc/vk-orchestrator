/**
 * checkCIPassing のユニットテスト。
 *
 * CI 判定を check-runs API（checks.listForRef。fine-grained PAT では Checks 権限が無く
 * 403 になる）から、fine-grained PAT でも読める Actions API（listWorkflowRunsForRepo）へ
 * 置き換えた変更の回帰テスト。
 *
 * fake octokit を差し込み、HTTP I/O なしでワークフロー実行の集約判定を検証する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';

const O = 'vektor-inc';
const R = 'task-queue';
const SHA = 'abc1234';

// 連番 id を振りつつワークフロー実行オブジェクトを組み立てるヘルパー。
//   workflow_id を省略すると 1件ごとに別ワークフロー扱い（dedup されない）。
let _autoId = 0;
function run({ name = 'ci', status = 'completed', conclusion = 'success', workflow_id, run_number = 1 } = {}) {
  _autoId += 1;
  return { name, status, conclusion, workflow_id: workflow_id ?? _autoId, run_number };
}

// fake octokit を差し込む。
//   - workflowRuns: octokit.paginate が返すワークフロー実行配列（全ページ集約済みを模す）
//   - calls:        paginate に渡された引数を記録（head_sha が伝播しているかの検証用）
function makeClient(workflowRuns, calls = {}) {
  _autoId = 0;
  const client = new GitHubClient({ token: 'dummy', owner: O, repo: R });
  const listFn = () => {}; // paginate がページングする実体。直接は呼ばれない。
  client.octokit = {
    actions: { listWorkflowRunsForRepo: listFn },
    // 実装は octokit.paginate(listWorkflowRunsForRepo, params) で全件取得する。
    paginate: async (fn, params) => {
      calls.fn = fn;
      calls.params = params;
      assert.equal(fn, listFn, 'paginate には listWorkflowRunsForRepo が渡る');
      return workflowRuns;
    },
    // 旧実装が誤って呼んでいないことを保証する（呼ばれたら即失敗）。
    checks: {
      listForRef: async () => {
        throw new Error('checks.listForRef は呼ばれてはいけない（Actions API へ移行済み）');
      },
    },
  };
  return client;
}

describe('checkCIPassing（Actions API ベース）', () => {
  it('ワークフロー実行が無ければ通過扱い（true）', async () => {
    const client = makeClient([]);
    assert.equal(await client.checkCIPassing(O, R, SHA), true);
  });

  it('head_sha を Actions API に伝播する', async () => {
    const calls = {};
    const client = makeClient([], calls);
    await client.checkCIPassing(O, R, SHA);
    assert.equal(calls.params.head_sha, SHA, 'CI判定対象の head SHA がそのまま渡る');
    assert.equal(calls.params.owner, O);
    assert.equal(calls.params.repo, R);
  });

  it('全実行が completed かつ success → true', async () => {
    const client = makeClient([
      run({ name: 'phpunit', conclusion: 'success' }),
      run({ name: 'lint',    conclusion: 'success' }),
    ]);
    assert.equal(await client.checkCIPassing(O, R, SHA), true);
  });

  it('skipped / neutral も通過扱い → true', async () => {
    const client = makeClient([
      run({ name: 'phpunit',  conclusion: 'success' }),
      run({ name: 'optional', conclusion: 'skipped' }),
      run({ name: 'info',     conclusion: 'neutral' }),
    ]);
    assert.equal(await client.checkCIPassing(O, R, SHA), true);
  });

  it('1件でも未完了（queued/in_progress）→ false', async () => {
    const client = makeClient([
      run({ name: 'phpunit', conclusion: 'success' }),
      run({ name: 'e2e',     status: 'in_progress', conclusion: null }),
    ]);
    assert.equal(await client.checkCIPassing(O, R, SHA), false);
  });

  it('1件でも失敗（failure）→ false', async () => {
    const client = makeClient([
      run({ name: 'phpunit', conclusion: 'success' }),
      run({ name: 'lint',    conclusion: 'failure' }),
    ]);
    assert.equal(await client.checkCIPassing(O, R, SHA), false);
  });

  it('completed だが conclusion=null（未確定）→ false（安全側）', async () => {
    const client = makeClient([
      run({ name: 'phpunit', conclusion: null }),
    ]);
    assert.equal(await client.checkCIPassing(O, R, SHA), false);
  });

  it('同一 workflow_id の再実行: 古い failure が残っても最新 success なら true（回帰）', async () => {
    // 二重トリガー / concurrency キャンセル後の再実行で、同じワークフローの run が
    // 複数返るケース。古い run（run_number 小）は failure、最新（run_number 大）は success。
    // workflow_id ごとに最新だけを見るので true になるべき（最新だけ見ないと永久に false）。
    const client = makeClient([
      run({ name: 'ci', workflow_id: 42, run_number: 1, conclusion: 'failure' }),
      run({ name: 'ci', workflow_id: 42, run_number: 2, conclusion: 'success' }),
    ]);
    assert.equal(await client.checkCIPassing(O, R, SHA), true);
  });

  it('同一 workflow_id の再実行: 最新が failure なら false', async () => {
    // 逆向き。最新（run_number 大）が failure なら、古い success が残っていても false。
    const client = makeClient([
      run({ name: 'ci', workflow_id: 42, run_number: 1, conclusion: 'success' }),
      run({ name: 'ci', workflow_id: 42, run_number: 2, conclusion: 'failure' }),
    ]);
    assert.equal(await client.checkCIPassing(O, R, SHA), false);
  });

  it('head_sha を paginate 経由で渡し、全件集約する', async () => {
    const calls = {};
    const client = makeClient([run({ conclusion: 'success' })], calls);
    await client.checkCIPassing(O, R, SHA);
    assert.equal(calls.params.head_sha, SHA, 'paginate のパラメータに head SHA が渡る');
    assert.equal(calls.params.owner, O);
    assert.equal(calls.params.repo, R);
  });
});
