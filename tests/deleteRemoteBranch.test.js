/**
 * GitHubClient.deleteRemoteBranch のユニットテスト。
 *
 * automerge 後クリーンアップで PR head の remote ref を消す経路。
 * 既に削除済みの ref は成功扱いにし、それ以外の API エラーは呼び出し側へ渡す。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';

const O = 'vektor-inc';
const R = 'task-queue';

function makeClient(deleteRefImpl) {
  const client = new GitHubClient({ token: 'dummy', owner: O, repo: R });
  client.octokit = { git: { deleteRef: deleteRefImpl } };
  return client;
}

describe('deleteRemoteBranch', () => {
  it('heads/<branch> ref を削除する', async () => {
    const calls = [];
    const client = makeClient(async (args) => {
      calls.push(args);
      return {};
    });

    await client.deleteRemoteBranch(O, R, 'feature/issue-64');

    assert.deepEqual(calls, [{
      owner: O,
      repo: R,
      ref: 'heads/feature/issue-64',
    }]);
  });

  it('404 は既に削除済みとして成功扱いにする', async () => {
    const client = makeClient(async () => {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    });

    await assert.doesNotReject(() => client.deleteRemoteBranch(O, R, 'feature/missing'));
  });

  it('422 でも ref 不存在を示すメッセージなら成功扱いにする', async () => {
    const client = makeClient(async () => {
      const err = new Error('Reference does not exist');
      err.status = 422;
      throw err;
    });

    await assert.doesNotReject(() => client.deleteRemoteBranch(O, R, 'feature/missing'));
  });

  it('422 でも ref 不存在以外のエラーは throw する', async () => {
    const client = makeClient(async () => {
      const err = new Error('Reference cannot be deleted');
      err.status = 422;
      throw err;
    });

    await assert.rejects(() => client.deleteRemoteBranch(O, R, 'feature/protected'), /Reference cannot be deleted/);
  });

  it('403 は throw する', async () => {
    const client = makeClient(async () => {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    });

    await assert.rejects(() => client.deleteRemoteBranch(O, R, 'feature/forbidden'), /Forbidden/);
  });
});
