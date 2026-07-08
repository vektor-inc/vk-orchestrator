/**
 * hasWpEnvConfig のユニットテスト。
 *
 * タスク着手時に wp-env 連携（ポート割り当て・{wpPort} 展開・マージ後クリーンアップ）を
 * 自動 ON/OFF する判定。対象リポのデフォルトブランチに `.wp-env.json` があれば true
 * （WordPress 案件）、404 なら false（非 WordPress）。404 以外のエラーは呼び出し側で
 * 安全側にフォールバックできるよう throw する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GitHubClient } from '../src/github/index.js';

const O = 'vektor-inc';

// repos.getContent を差し込む fake octokit。impl が返す/投げる値をそのまま使う。
function makeClient(getContentImpl) {
  const client = new GitHubClient({ token: 'dummy', owner: O, repo: 'x' });
  client.octokit = { repos: { getContent: getContentImpl } };
  return client;
}

describe('hasWpEnvConfig', () => {
  it('.wp-env.json が存在すれば true（取得成功）', async () => {
    const client = makeClient(async ({ path }) => {
      assert.equal(path, '.wp-env.json');
      return { data: { name: '.wp-env.json' } };
    });
    assert.equal(await client.hasWpEnvConfig(O, 'vk-blocks-pro'), true);
  });

  it('404（ファイル無し）なら false', async () => {
    const client = makeClient(async () => {
      const err = new Error('Not Found');
      err.status = 404;
      throw err;
    });
    assert.equal(await client.hasWpEnvConfig(O, 'task-queue'), false);
  });

  it('404 以外のエラー（403 等）は throw する（呼び出し側で安全側にフォールバック）', async () => {
    const client = makeClient(async () => {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    });
    await assert.rejects(() => client.hasWpEnvConfig(O, 'secret-repo'), /Forbidden/);
  });
});
