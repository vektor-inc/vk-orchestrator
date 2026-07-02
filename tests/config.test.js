/**
 * 統合設定 (src/config.js) のユニットテスト。
 * - loadUnifiedConfig: JSON 読み込み / 欠損時は {}
 * - applyConfigToEnv:  env > config.json の優先順位
 * - toVkTerminalsConfig: vk-terminals 用キーへの変換
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadUnifiedConfig,
  applyConfigToEnv,
  toVkTerminalsConfig,
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

test('toVkTerminalsConfig: vk-terminals 用キーに変換する', () => {
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

test('toVkTerminalsConfig: トークンを vk-terminals 設定に絶対に含めない', () => {
  const out = toVkTerminalsConfig({
    github: { token: 'ghp_secret' },
    vkTerminals: { host: '127.0.0.1' },
  });
  assert.equal(JSON.stringify(out).includes('ghp_secret'), false);
  assert.equal('token' in out, false);
});
