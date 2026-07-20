import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { LocalQueueClient } from '../src/local-queue/index.js';
import { runQueueClientContract } from './contract/queueClientContract.js';

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'vko-local-queue-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeGitHubClient(extra = {}) {
  return {
    owner: 'vektor-inc',
    repo: 'task-queue',
    queueLabel: 'task-queue',
    postSourceCompletionComment: async () => {},
    ...extra,
  };
}

function writeQueue(queuePath, tasks) {
  const maxId = tasks.reduce((max, task) => Math.max(max, task.id), 0);
  writeFileSync(queuePath, JSON.stringify({
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
    nextId: maxId + 1,
    tasks,
  }, null, 2));
}

function readQueue(queuePath) {
  return JSON.parse(readFileSync(queuePath, 'utf8'));
}

function seedToTask(issue) {
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, issue.number)).toISOString();
  return {
    id: issue.number,
    state: 'open',
    title: issue.title,
    body: issue.body ?? '',
    status: 'ready',
    priority: issue.priority ?? 'none',
    sequential: issue.sequential === true,
    automerge: issue.automerge === true,
    cwd: null,
    prUrl: null,
    comments: [],
    assignees: issue.assignees ?? [],
    createdAt: now,
    updatedAt: now,
  };
}

function createLocalQueueClient(seedIssues, options = {}) {
  const dir = makeTempDir();
  const queuePath = join(dir, 'queue.json');
  writeQueue(queuePath, seedIssues.map(seedToTask));
  return new LocalQueueClient({
    token: 'test-token',
    owner: 'vektor-inc',
    repo: 'task-queue',
    queuePath,
    githubClient: options.githubClient ?? fakeGitHubClient(),
  });
}

runQueueClientContract({ label: 'LocalQueueClient', createClient: createLocalQueueClient });

test('LocalQueueClient: setStatus は queue.json を更新し、done 遷移時だけ source 完了コメントを委譲する', async () => {
  const calls = [];
  const client = createLocalQueueClient([
    {
      number: 11,
      title: 'source task',
      body: 'https://github.com/vektor-inc/example/issues/55',
    },
  ], {
    githubClient: fakeGitHubClient({
      postSourceCompletionComment: async (...args) => calls.push(args),
    }),
  });

  await client.setStatus(11, 'status:done');
  await client.setStatus(11, 'status:done');

  const queue = readQueue(client.queuePath);
  assert.equal(queue.tasks[0].status, 'done');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], {
    url: 'https://github.com/vektor-inc/example/issues/55',
    owner: 'vektor-inc',
    repo: 'example',
    number: 55,
  });
  assert.equal(calls[0][1], 'local://queue/11');
  assert.equal(calls[0][2], 'status:done');
});

test('LocalQueueClient: closeIssue は物理削除せず一覧から除外する', async () => {
  const client = createLocalQueueClient([
    { number: 21, title: 'close me' },
    { number: 22, title: 'keep me' },
  ]);

  await client.closeIssue(21);

  assert.deepEqual((await client.listAllQueueIssues()).map(issue => issue.number), [22]);
  const closed = readQueue(client.queuePath).tasks.find(task => task.id === 21);
  assert.equal(closed.state, 'closed');
});

test('LocalQueueClient: setPriority / setSequential は issue 互換 labels に反映される', async () => {
  const client = createLocalQueueClient([{ number: 31, title: 'label task' }]);

  await client.setPriority(31, 'high');
  await client.setSequential(31, 'sequential');

  const [issue] = await client.listAllQueueIssues();
  assert.ok(issue.labels.includes('priority:high'));
  assert.ok(issue.labels.includes('sequential'));
  assert.equal(client.isSequential(issue), true);
});

test('LocalQueueClient: getIssueState は自キューのメタ issue を queue.json から返す', async () => {
  const client = createLocalQueueClient([
    {
      number: 32,
      title: 'state task',
      body: 'body text',
      priority: 'high',
      sequential: true,
      automerge: true,
    },
  ]);

  const issue = await client.getIssueState(client.owner, client.repo, 32, { retryDelays: [] });

  assert.equal(issue.state, 'open');
  assert.equal(issue.closedAt, null);
  assert.equal(issue.title, 'state task');
  assert.equal(issue.htmlUrl, 'local://queue/32');
  assert.equal(issue.body, 'body text');
  assert.ok(issue.labels.includes('status:ready'));
  assert.ok(issue.labels.includes('priority:high'));
  assert.ok(issue.labels.includes('sequential'));
  assert.ok(issue.labels.includes('automerge'));
});

test('LocalQueueClient: getIssueState は自キューに存在しない id なら 404 を throw する', async () => {
  const client = createLocalQueueClient([{ number: 33, title: 'known task' }]);

  await assert.rejects(
    client.getIssueState(client.owner, client.repo, 999, { retryDelays: [] }),
    (err) => err.status === 404,
  );
});

test('LocalQueueClient: getIssueState は対象リポ issue なら内包 GitHubClient に委譲する', async () => {
  const calls = [];
  const expected = { state: 'open', closedAt: null, title: 'source issue', htmlUrl: 'https://github.com/vektor-inc/example/issues/55', body: '', labels: [] };
  const client = createLocalQueueClient([], {
    githubClient: fakeGitHubClient({
      getIssueState: async (...args) => {
        calls.push(args);
        return expected;
      },
    }),
  });
  const opts = { retryDelays: [] };

  const actual = await client.getIssueState('vektor-inc', 'example', 55, opts);

  assert.equal(actual, expected);
  assert.deepEqual(calls, [['vektor-inc', 'example', 55, opts]]);
});

test('LocalQueueClient: appendPRUrlToIssue は冪等に PR URL を追記する', async () => {
  const client = createLocalQueueClient([{ number: 41, title: 'pr task', body: 'body' }]);
  const prUrl = 'https://github.com/vektor-inc/example/pull/9';

  await client.appendPRUrlToIssue(41, prUrl);
  await client.appendPRUrlToIssue(41, prUrl);

  const task = readQueue(client.queuePath).tasks[0];
  assert.equal(task.prUrl, prUrl);
  assert.equal([...task.body.matchAll(/\*\*PR:\*\*/g)].length, 1);
  assert.equal(client.extractPRUrlFromIssueBody(task.body), prUrl);
});

test('LocalQueueClient: fetchPendingIssues は priority high / medium / low / none 順で返す', async () => {
  const client = createLocalQueueClient([
    { number: 51, title: 'low', priority: 'low' },
    { number: 52, title: 'none', priority: 'none' },
    { number: 53, title: 'high', priority: 'high' },
    { number: 54, title: 'medium', priority: 'medium' },
  ]);

  assert.deepEqual(
    (await client.fetchPendingIssues()).map(issue => issue.number),
    [53, 54, 51, 52],
  );
});

test('LocalQueueClient: createTaskQueueIssueFromSource と findTaskQueueIssueBySourceUrl が queue.json を扱う', async () => {
  const client = createLocalQueueClient([]);
  const source = {
    number: 71,
    title: 'Implement local backend',
    html_url: 'https://github.com/vektor-inc/example/issues/71',
    repository_url: 'https://api.github.com/repos/vektor-inc/example',
  };

  const created = await client.createTaskQueueIssueFromSource(source);
  const found = await client.findTaskQueueIssueBySourceUrl(source.html_url);

  assert.equal(created.number, 1);
  assert.equal(created.title, '[example] Implement local backend');
  assert.equal(created.body, source.html_url);
  assert.equal(found.number, 1);
  assert.ok(found.labels.includes('status:awaiting-approval'));
});
