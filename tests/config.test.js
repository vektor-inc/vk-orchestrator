/**
 * 統合設定 (src/config.js) のユニットテスト。
 * - loadUnifiedConfig: JSON 読み込み / 欠損時は {}
 * - applyConfigToEnv:  env > config.json の優先順位
 * - toVkTerminalsConfig: VK Terminals 用キーへの変換
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadUnifiedConfig,
  applyConfigToEnv,
  toVkTerminalsConfig,
  vkTerminalsConfigPath,
  writeVkTerminalsConfig,
  getTaskConfig,
  getProtocolConfig,
  getLabelsConfig,
  buildSettingsDescriptor,
} from '../src/config.js';

function withTmpConfig(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'vko-cfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj));
  try {
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadUnifiedConfig: 存在しないパスは {} を返す', () => {
  assert.deepEqual(loadUnifiedConfig('/no/such/file.json'), {});
});

test('loadUnifiedConfig: JSON を読み込む', () => {
  withTmpConfig({ github: { owner: 'acme' } }, (path) => {
    assert.deepEqual(loadUnifiedConfig(path), { github: { owner: 'acme' } });
  });
});

test('applyConfigToEnv: 未設定の env に config 値を反映する', () => {
  const keys = ['GITHUB_OWNER', 'GITHUB_REPO', 'QUEUE_LABEL', 'VK_TERMINALS_PORT', 'ASSIGNEE_FILTER'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    applyConfigToEnv({
      github: { owner: 'acme', repo: 'q', queueLabel: 'lbl' },
      orchestrator: { assigneeFilter: 'alice' },
      vkTerminals: { port: 20000 },
    });
    assert.equal(process.env.GITHUB_OWNER, 'acme');
    assert.equal(process.env.GITHUB_REPO, 'q');
    assert.equal(process.env.QUEUE_LABEL, 'lbl');
    assert.equal(process.env.VK_TERMINALS_PORT, '20000');
    assert.equal(process.env.ASSIGNEE_FILTER, 'alice');
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('applyConfigToEnv: 既存 env を上書きしない（env が優先）', () => {
  const saved = process.env.GITHUB_OWNER;
  process.env.GITHUB_OWNER = 'from-env';
  try {
    applyConfigToEnv({ github: { owner: 'from-config' } });
    assert.equal(process.env.GITHUB_OWNER, 'from-env');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_OWNER;
    else process.env.GITHUB_OWNER = saved;
  }
});

test('applyConfigToEnv: null の assigneeFilter は反映しない', () => {
  const saved = process.env.ASSIGNEE_FILTER;
  delete process.env.ASSIGNEE_FILTER;
  try {
    applyConfigToEnv({ orchestrator: { assigneeFilter: null } });
    assert.equal(process.env.ASSIGNEE_FILTER, undefined);
  } finally {
    if (saved !== undefined) process.env.ASSIGNEE_FILTER = saved;
  }
});

test('toVkTerminalsConfig: VK Terminals 用キーに変換する', () => {
  const out = toVkTerminalsConfig({
    vkTerminals: {
      host: '100.64.0.1',
      initialCommand: 'スキルで開始',
      agentroom: true,
      additionalPanes: [{ cwd: '/x' }],
    },
  });
  assert.deepEqual(out, {
    apiHost: '100.64.0.1',
    initialCommand: 'スキルで開始',
    agentroom: true,
    additionalPanes: [{ cwd: '/x' }],
  });
});

test('toVkTerminalsConfig: vkTerminals 未定義なら空オブジェクト', () => {
  assert.deepEqual(toVkTerminalsConfig({}), {});
});

test('applyConfigToEnv: GITHUB_TOKEN を config.json から反映できる', () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    applyConfigToEnv({ github: { token: 'ghp_fromconfig' } });
    assert.equal(process.env.GITHUB_TOKEN, 'ghp_fromconfig');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('applyConfigToEnv: .env の GITHUB_TOKEN が config.json より優先される', () => {
  const saved = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_fromenv';
  try {
    applyConfigToEnv({ github: { token: 'ghp_fromconfig' } });
    assert.equal(process.env.GITHUB_TOKEN, 'ghp_fromenv');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved;
  }
});

test('vkTerminalsConfigPath: 指定した VK Terminals ディレクトリ内 config.json を指す', () => {
  assert.equal(vkTerminalsConfigPath('/opt/vk-terminals'), '/opt/vk-terminals/config.json');
});

test('writeVkTerminalsConfig: 指定ディレクトリ内 config.json へ書き出す', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vko-vkdir-'));
  try {
    const target = writeVkTerminalsConfig(
      { vkTerminals: { host: '127.0.0.1', agentroom: true } },
      dir,
    );
    assert.equal(target, join(dir, 'config.json'));
    const written = JSON.parse(readFileSync(target, 'utf8'));
    assert.deepEqual(written, { apiHost: '127.0.0.1', agentroom: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toVkTerminalsConfig: トークンを VK Terminals 設定に絶対に含めない', () => {
  const out = toVkTerminalsConfig({
    github: { token: 'ghp_secret' },
    vkTerminals: { host: '127.0.0.1' },
  });
  assert.equal(JSON.stringify(out).includes('ghp_secret'), false);
  assert.equal('token' in out, false);
});

// -------------------------------------------------------
// task / protocol / labels セクション（汎用化の土台。既定値は現行ハードコード値）
// -------------------------------------------------------

const TASK_ENV_KEYS = ['TASK_COMMAND_TEMPLATE', 'TASK_WP_PORT_BASE', 'TASK_WP_PORT_STRIDE'];

function withoutTaskEnv(fn) {
  const saved = Object.fromEntries(TASK_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of TASK_ENV_KEYS) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of TASK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('getTaskConfig: config 無しで既定値を返す', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({});
    assert.ok(t.commandTemplate.includes('/vk-kore'));
    assert.ok(t.commandTemplate.includes('wp-env-port='));
    assert.equal(t.portBase, 9100);
    assert.equal(t.portStride, 2);
  });
});

test('getProtocolConfig: 既定値を返す', () => {
  const p = getProtocolConfig({});
  assert.equal(p.agentMarker, 'Comment by vk-agents');
  assert.equal(p.statusLinePrefix, 'Status:');
  assert.equal(p.statusTokens.waitingInput, 'waiting-input');
  assert.equal(p.statusTokens.noAction, 'no-action');
  assert.equal(p.statusTokens.answered, 'answered');
});

test('getLabelsConfig: 既定値を返す', () => {
  const l = getLabelsConfig({});
  assert.equal(l.status.inProgress, 'status:in-progress');
  assert.equal(l.status.awaitingApproval, 'status:awaiting-approval');
  assert.equal(l.priority.high, 'priority:high');
  assert.equal(l.automerge, 'automerge');
  assert.equal(l.sequential, 'sequential');
  assert.equal(l.parallel, 'parallel');
  assert.equal(l.workingInProgress, '作業中');
  assert.equal(l.e2ePassed, 'e2e-passed');
  assert.equal(l.e2ePassedShaPrefix, 'e2e-passed-sha:');
});

test('getLabelsConfig: config.json の部分上書きが効き、未指定キーは既定にフォールバック', () => {
  const l = getLabelsConfig({ labels: { status: { done: 'x' } } });
  assert.equal(l.status.done, 'x');            // 上書きされる
  assert.equal(l.status.inProgress, 'status:in-progress'); // 未指定は既定のまま
  assert.equal(l.automerge, 'automerge');      // 他セクションも既定のまま
});

test('getProtocolConfig: statusTokens の部分上書き（ディープマージ）', () => {
  const p = getProtocolConfig({ protocol: { statusTokens: { answered: 'done' } } });
  assert.equal(p.statusTokens.answered, 'done');
  assert.equal(p.statusTokens.waitingInput, 'waiting-input'); // 未指定は既定
  assert.equal(p.agentMarker, 'Comment by vk-agents');
});

test('getTaskConfig: config.json が既定を上書きする', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({ task: { portBase: 9200 } });
    assert.equal(t.portBase, 9200);
    assert.equal(t.portStride, 2); // 未指定は既定
  });
});

test('getTaskConfig: env が config.json より優先される', () => {
  const saved = Object.fromEntries(TASK_ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.TASK_WP_PORT_BASE = '9500';
  process.env.TASK_WP_PORT_STRIDE = '4';
  process.env.TASK_COMMAND_TEMPLATE = '/custom {issueUrl}';
  try {
    const t = getTaskConfig({ task: { portBase: 9200, portStride: 3, commandTemplate: '/cfg' } });
    assert.equal(t.portBase, 9500);
    assert.equal(t.portStride, 4);
    assert.equal(t.commandTemplate, '/custom {issueUrl}');
  } finally {
    for (const k of TASK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test('buildSettingsDescriptor: groups に タスク/プロトコル/ラベル が含まれる', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const labels = desc.groups.map((g) => g.label);
  assert.ok(labels.includes('タスク'));
  assert.ok(labels.includes('プロトコル'));
  assert.ok(labels.includes('ラベル'));
});
