/**
 * handlePaneMissing（pane 消失時の自動再開）のユニットテスト。
 *
 * done-gate 系のテストと同様、GitHub / state / cleanup への副作用は全て fake を
 * 依存注入して検証する。カバーするケース:
 *   - pane 消失 ＋ PR 未生成 → status:ready へ自動再開（cleanup・state リセット・コメント込み）
 *   - 再開上限超過 → 従来どおり failTask（status:failed 経路）に倒す
 *   - PR あり → 何もしない（通常ルートに任せる）
 * ほか、PR 確認失敗時の見送り・ready 遷移失敗時のリトライ順序も確認する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handlePaneMissing } from '../src/engine/pane-resume.js';

// console.log / warn を黙らせるためのスタブ
const silentLogger = { log: () => {}, warn: () => {} };

// task-queue 側 issue の fake（対象 issue の解決は resolveTarget の fake が担う）
const issue = {
  number: 246,
  title: 'https://github.com/owner/repo/issues/42 を対応',
  body: '対象: https://github.com/owner/repo/issues/42',
};

// 呼び出し記録付きの deps 一式を組み立てる。overrides で個別に差し替える。
function makeDeps(overrides = {}) {
  const calls = {
    findPRForIssue: [],
    cleanupForIssue: [],
    updateTask: [],
    setStatus: [],
    addComment: [],
    failTask: [],
  };
  const deps = {
    findPRForIssue: async (owner, repo, number) => {
      calls.findPRForIssue.push([owner, repo, number]);
      return null;
    },
    resolveTarget: () => ({ owner: 'owner', repo: 'repo', number: 42, isSelf: false }),
    cleanupForIssue: async (args) => {
      calls.cleanupForIssue.push(args);
      return { containers: 1 };
    },
    formatCleanupSummary: () => '- コンテナ削除: 1 件',
    updateTask: async (issueNumber, patch) => {
      calls.updateTask.push([issueNumber, patch]);
    },
    setStatus: async (issueNumber, label) => {
      calls.setStatus.push([issueNumber, label]);
    },
    addComment: async (issueNumber, body) => {
      calls.addComment.push([issueNumber, body]);
    },
    failTask: async (reason) => {
      calls.failTask.push(reason);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('handlePaneMissing', () => {
  it('PR 未生成なら cleanup・state リセットのうえ status:ready へ自動再開する', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, wpPort: 8888, repo: 'owner/repo' };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'resumed', resumeCount: 1 });

    // PR の有無は対象 issue（resolveTarget の結果）で確認している
    assert.deepEqual(calls.findPRForIssue, [['owner', 'repo', 42]]);

    // wp-env の掃除が wpPort 付きで走っている
    assert.equal(calls.cleanupForIssue.length, 1);
    assert.deepEqual(calls.cleanupForIssue[0], { issueNumber: 246, wpPort: 8888 });

    // 再開回数の記録 → termId / paneMissingTicks / wpPort の明示リセットの順で state を更新
    assert.equal(calls.updateTask.length, 2);
    assert.deepEqual(calls.updateTask[0], [246, { resumeCount: 1 }]);
    assert.deepEqual(calls.updateTask[1], [246, { termId: null, paneMissingTicks: 0, wpPort: null }]);

    // status:ready へ再キュー
    assert.deepEqual(calls.setStatus, [[246, 'status:ready']]);

    // 「N/上限回目」形式の自動再開コメント（クリーンアップ結果込み）
    assert.equal(calls.addComment.length, 1);
    assert.equal(calls.addComment[0][0], 246);
    assert.match(calls.addComment[0][1], /🔁 作業ペイン消失を検知したため自動再開しました（1\/3回目）/);
    assert.match(calls.addComment[0][1], /コンテナ削除: 1 件/);

    // failed 経路には入らない
    assert.equal(calls.failTask.length, 0);
  });

  it('再開上限を超過したら従来どおり failTask（status:failed 経路）に倒す', async () => {
    const { deps, calls } = makeDeps();
    // 既に上限（3 回）まで再開済みのタスク
    const saved = { termId: 22, wpPort: 8888, resumeCount: 3 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'failed' });

    // failed 化は failTask（markTaskFailed 相当）に委譲し、理由に上限超過が分かる文言を含む
    assert.equal(calls.failTask.length, 1);
    assert.match(calls.failTask[0], /termId:22/);
    assert.match(calls.failTask[0], /上限 3 回/);

    // 再開系の副作用は一切走らない
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.addComment.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.cleanupForIssue.length, 0);
  });

  it('PR が既にあるタスクは再開しない（通常ルートに任せて何もしない）', async () => {
    const { deps, calls } = makeDeps({
      findPRForIssue: async () => ({ number: 99, html_url: 'https://github.com/owner/repo/pull/99' }),
    });
    const saved = { termId: 22, wpPort: 8888 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'has-pr' });

    // 再開・failed いずれの副作用も走らない
    assert.equal(calls.cleanupForIssue.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.addComment.length, 0);
    assert.equal(calls.failTask.length, 0);
  });

  it('PR 確認に失敗したら今回は見送る（次ループで再評価・副作用なし）', async () => {
    const { deps, calls } = makeDeps({
      findPRForIssue: async () => {
        throw new Error('rate limit');
      },
    });

    const result = await handlePaneMissing(issue, { termId: 22 }, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'skipped' });
    assert.equal(calls.cleanupForIssue.length, 0);
    assert.equal(calls.updateTask.length, 0);
    assert.equal(calls.setStatus.length, 0);
    assert.equal(calls.failTask.length, 0);
  });

  it('2 回目の再開はコメントの回数表記と resumeCount が増える', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 30, wpPort: 8890, resumeCount: 1 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'resumed', resumeCount: 2 });
    assert.deepEqual(calls.updateTask[0], [246, { resumeCount: 2 }]);
    assert.match(calls.addComment[0][1], /（2\/3回目）/);
  });

  it('wpPort が無いタスク（wp-env 無効）は cleanup をスキップして再開する', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, wpPort: null };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'resumed', resumeCount: 1 });
    assert.equal(calls.cleanupForIssue.length, 0);
    assert.deepEqual(calls.setStatus, [[246, 'status:ready']]);
    // コメントにクリーンアップ結果セクションは付かない
    assert.doesNotMatch(calls.addComment[0][1], /クリーンアップ結果/);
  });

  it('ready 遷移に失敗したら state はリセットせず次ループの再検知に委ねる（resumeCount は記録済み）', async () => {
    const { deps, calls } = makeDeps({
      setStatus: async () => {
        throw new Error('label API down');
      },
    });
    const saved = { termId: 22, wpPort: 8888 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 3,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'retry', resumeCount: 1 });

    // resumeCount は ready 遷移前に記録される（遷移失敗の繰り返しが無限リトライに化けない）
    assert.deepEqual(calls.updateTask, [[246, { resumeCount: 1 }]]);
    // termId を残したまま戻るので、次ループの scanWatchdog が pane 消失を再検知できる
    assert.equal(calls.addComment.length, 0);
    assert.equal(calls.failTask.length, 0);
  });

  it('resumeMax オプションで上限を上書きできる（既定 3 回）', async () => {
    const { deps, calls } = makeDeps();
    const saved = { termId: 22, resumeCount: 1 };

    const result = await handlePaneMissing(issue, saved, deps, {
      resumeMax: 1,
      logger: silentLogger,
    });

    assert.deepEqual(result, { action: 'failed' });
    assert.match(calls.failTask[0], /上限 1 回/);
  });
});
