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
  GPU_MODES,
  defaultGpuMode,
  getVkTerminalsGpuMode,
  gpuLaunchOptions,
  DEFAULT_LABELS,
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

const TASK_ENV_KEYS = ['TASK_COMMAND_TEMPLATE', 'TASK_WP_PORT_BASE', 'TASK_WP_PORT_STRIDE', 'TASK_WP_ENV_ENABLED', 'TASK_REQUIRE_E2E_GATE'];

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
    assert.ok(t.commandTemplate.includes('headless=1'));
    assert.equal(t.portBase, 9100);
    assert.equal(t.portStride, 2);
  });
});

test('getTaskConfig: wpEnv.enabled は既定で true', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({});
    assert.equal(t.wpEnv.enabled, true);
  });
});

test('getTaskConfig: config.json で wpEnv.enabled を false に上書きできる', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({ task: { wpEnv: { enabled: false } } });
    assert.equal(t.wpEnv.enabled, false);
    // 他の task キーは既定のまま
    assert.equal(t.portBase, 9100);
    assert.equal(t.portStride, 2);
  });
});

test('getTaskConfig: TASK_WP_ENV_ENABLED env が config.json より優先される', () => {
  withoutTaskEnv(() => {
    // config.json で true 指定 → env の 'false' が勝つ
    process.env.TASK_WP_ENV_ENABLED = 'false';
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: true } } }).wpEnv.enabled, false);

    // '0' も false 扱い
    process.env.TASK_WP_ENV_ENABLED = '0';
    assert.equal(getTaskConfig({}).wpEnv.enabled, false);

    // 'true' は true 扱い（config.json の false を上書きして true に戻せる）
    process.env.TASK_WP_ENV_ENABLED = 'true';
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: false } } }).wpEnv.enabled, true);
  });
});

test('getTaskConfig: 空文字の TASK_WP_ENV_ENABLED は無視され config.json/既定が使われる', () => {
  withoutTaskEnv(() => {
    process.env.TASK_WP_ENV_ENABLED = '';
    assert.equal(getTaskConfig({}).wpEnv.enabled, true);
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: false } } }).wpEnv.enabled, false);
  });
});

test('getTaskConfig: 空白のみの TASK_WP_ENV_ENABLED は未指定扱い（true に倒さない）', () => {
  withoutTaskEnv(() => {
    process.env.TASK_WP_ENV_ENABLED = '   ';
    // 空白のみは無視され、config.json の false がそのまま採用される
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: false } } }).wpEnv.enabled, false);
    assert.equal(getTaskConfig({}).wpEnv.enabled, true); // config も無ければ既定 true
  });
});

test('getTaskConfig: requireE2eGate は既定で true', () => {
  withoutTaskEnv(() => {
    assert.equal(getTaskConfig({}).requireE2eGate, true);
  });
});

test('getTaskConfig: TASK_REQUIRE_E2E_GATE env が config.json より優先される', () => {
  withoutTaskEnv(() => {
    // 'false' / '0' は false 扱い
    process.env.TASK_REQUIRE_E2E_GATE = 'false';
    assert.equal(getTaskConfig({ task: { requireE2eGate: true } }).requireE2eGate, false);

    process.env.TASK_REQUIRE_E2E_GATE = '0';
    assert.equal(getTaskConfig({}).requireE2eGate, false);

    // それ以外の非空値は true 扱い（config.json の false を上書きして true に戻せる）
    process.env.TASK_REQUIRE_E2E_GATE = 'true';
    assert.equal(getTaskConfig({ task: { requireE2eGate: false } }).requireE2eGate, true);
  });
});

test('getTaskConfig: 空文字の TASK_REQUIRE_E2E_GATE は無視され config.json/既定が使われる', () => {
  withoutTaskEnv(() => {
    process.env.TASK_REQUIRE_E2E_GATE = '';
    assert.equal(getTaskConfig({}).requireE2eGate, true);
    assert.equal(getTaskConfig({ task: { requireE2eGate: false } }).requireE2eGate, false);
  });
});

// -------------------------------------------------------
// GUI 設定パネル由来の空値汚染（"" / null / [] / {}）が既定を潰さないこと
// （設定パネルは全項目を書き戻すため、未入力項目が空で保存されうる）
// -------------------------------------------------------

test('getTaskConfig: 空文字/null の config 値は既定にフォールバックする（GUI 汚染耐性）', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({ task: { commandTemplate: '', portBase: null, portStride: null } });
    assert.ok(t.commandTemplate.includes('/vk-kore')); // 既定に戻る
    assert.equal(t.portBase, 9100);
    assert.equal(t.portStride, 2);
  });
});

test('getLabelsConfig: 空配列/空文字の config 値は既定にフォールバックする（GUI 汚染耐性）', () => {
  const l = getLabelsConfig({ labels: { status: [], priority: [], automerge: '', sequential: '', parallel: '' } });
  assert.equal(l.status.ready, 'status:ready');       // 空配列 [] で潰れない
  assert.equal(l.status.inProgress, 'status:in-progress');
  assert.equal(l.priority.high, 'priority:high');
  assert.equal(l.automerge, 'automerge');             // 空文字 "" で潰れない
  assert.equal(l.sequential, 'sequential');
  assert.equal(l.parallel, 'parallel');
});

test('getProtocolConfig: 空文字/空配列の config 値は既定にフォールバックする（GUI 汚染耐性）', () => {
  const p = getProtocolConfig({ protocol: { statusLinePrefix: '', statusTokens: [] } });
  assert.equal(p.statusLinePrefix, 'Status:');
  assert.equal(p.statusTokens.waitingInput, 'waiting-input');
});

test('pruneEmpty 経由でも false / 0 は有意値として残る', () => {
  withoutTaskEnv(() => {
    // wpEnv.enabled:false は空扱いにされず反映される
    assert.equal(getTaskConfig({ task: { wpEnv: { enabled: false } } }).wpEnv.enabled, false);
    assert.equal(getTaskConfig({ task: { requireE2eGate: false } }).requireE2eGate, false);
  });
});

test('getProtocolConfig: 既定値を返す', () => {
  const p = getProtocolConfig({});
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
  assert.equal(l.workingInProgress, 'working');
});

test('getLabelsConfig: workingInProgress は config.json で上書き可能（GUI 非公開の隠しオプション）', () => {
  const l = getLabelsConfig({ labels: { workingInProgress: '作業中' } });
  assert.equal(l.workingInProgress, '作業中');   // 上書きされる
  assert.equal(l.automerge, 'automerge');        // 未指定キーは既定のまま
});

test('DEFAULT_LABELS: dead config だった e2ePassed / e2ePassedShaPrefix は存在しない', () => {
  assert.equal('e2ePassed' in DEFAULT_LABELS, false);
  assert.equal('e2ePassedShaPrefix' in DEFAULT_LABELS, false);
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
});

test('getTaskConfig: config.json が既定を上書きする', () => {
  withoutTaskEnv(() => {
    const t = getTaskConfig({ task: { portBase: 9200 } });
    assert.equal(t.portBase, 9200);
    assert.equal(t.portStride, 2); // 未指定は既定
  });
});

test('getTaskConfig: env が config.json より優先される', () => {
  // withoutTaskEnv が TASK_* を退避→finally で復元するので、その中で env を設定すれば
  // save/restore を手書きせずに済む（重複解消）。
  withoutTaskEnv(() => {
    process.env.TASK_WP_PORT_BASE = '9500';
    process.env.TASK_WP_PORT_STRIDE = '4';
    process.env.TASK_COMMAND_TEMPLATE = '/custom {issueUrl}';
    const t = getTaskConfig({ task: { portBase: 9200, portStride: 3, commandTemplate: '/cfg' } });
    assert.equal(t.portBase, 9500);
    assert.equal(t.portStride, 4);
    assert.equal(t.commandTemplate, '/custom {issueUrl}');
  });
});

test('getLabelsConfig: __proto__ ペイロードでグローバル汚染しない', () => {
  const l = getLabelsConfig(JSON.parse('{"labels":{"__proto__":{"polluted":"x"}}}'));
  assert.equal({}.polluted, undefined);
  assert.equal(l.automerge, 'automerge'); // 既定は維持
});

test('buildSettingsDescriptor: 共有契約系フィールドを UI から除外する', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const labels = desc.groups.map((g) => g.label);
  assert.ok(labels.includes('タスク'));
  assert.ok(!labels.includes('プロトコル'));
  assert.ok(!labels.includes('ラベル'));

  const fieldKeys = desc.groups.flatMap((g) => (g.fields ?? []).map((f) => f.key));
  assert.ok(fieldKeys.includes('task.commandTemplate'));
  assert.ok(fieldKeys.includes('task.wpEnv.enabled'));
  assert.ok(fieldKeys.includes('task.requireE2eGate'));

  assert.ok(!fieldKeys.includes('protocol.statusLinePrefix'));
  assert.ok(!fieldKeys.includes('protocol.statusTokens'));
  // 識別行マーカーは撤去済み（#9）。GUI フィールドも消えていること。
  assert.ok(!fieldKeys.includes('protocol.agentMarker'));
  assert.ok(!fieldKeys.includes('labels.status'));
  assert.ok(!fieldKeys.includes('labels.priority'));
  assert.ok(!fieldKeys.includes('labels.automerge'));
  assert.ok(!fieldKeys.includes('labels.sequential'));
  assert.ok(!fieldKeys.includes('labels.parallel'));
  // dead config だった e2e 完了マーカー枠（#10）も GUI から消えていること。
  assert.ok(!fieldKeys.includes('labels.e2ePassed'));
  assert.ok(!fieldKeys.includes('labels.e2ePassedShaPrefix'));
  // 作業中ラベルは隠しオプション化（#11）。GUI フィールドには出ないこと。
  assert.ok(!fieldKeys.includes('labels.workingInProgress'));
  assert.ok(!fieldKeys.includes('task.portBase'));
  assert.ok(!fieldKeys.includes('task.portStride'));

  // task.wpEnv.enabled は boolean 型の項目として登録されていること。
  const wpEnvField = desc.groups
    .flatMap((g) => g.fields ?? [])
    .find((f) => f.key === 'task.wpEnv.enabled');
  assert.ok(wpEnvField);
  assert.equal(wpEnvField.type, 'boolean');

  // task.requireE2eGate も boolean 型の項目として登録されていること。
  const requireE2eGateField = desc.groups
    .flatMap((g) => g.fields ?? [])
    .find((f) => f.key === 'task.requireE2eGate');
  assert.ok(requireE2eGateField);
  assert.equal(requireE2eGateField.type, 'boolean');
});

test('buildSettingsDescriptor: sourceOrg は空欄保存時に未指定として扱う', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const sourceOrgField = desc.groups
    .flatMap((g) => g.fields ?? [])
    .find((f) => f.key === 'github.sourceOrg');
  assert.ok(sourceOrgField);
  assert.equal(sourceOrgField.emptyToNull, true);
});

// -------------------------------------------------------
// GPU 起動モード（GUI/Electron の HW-GPU 利用切り替え）
// -------------------------------------------------------

function withoutGpuEnv(fn) {
  const saved = process.env.VK_TERMINALS_GPU;
  delete process.env.VK_TERMINALS_GPU;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.VK_TERMINALS_GPU;
    else process.env.VK_TERMINALS_GPU = saved;
  }
}

test('defaultGpuMode: macOS は default、それ以外は off', () => {
  assert.equal(defaultGpuMode('darwin'), 'default');
  assert.equal(defaultGpuMode('linux'), 'off');
  assert.equal(defaultGpuMode('win32'), 'off');
});

test('getVkTerminalsGpuMode: 未設定はプラットフォーム既定にフォールバック', () => {
  withoutGpuEnv(() => {
    assert.equal(getVkTerminalsGpuMode({}, 'linux'), 'off');
    assert.equal(getVkTerminalsGpuMode({}, 'darwin'), 'default');
  });
});

test('getVkTerminalsGpuMode: config.json の値を採用する', () => {
  withoutGpuEnv(() => {
    assert.equal(getVkTerminalsGpuMode({ vkTerminals: { gpu: 'off' } }, 'darwin'), 'off');
    // 大文字・前後空白は正規化する
    assert.equal(getVkTerminalsGpuMode({ vkTerminals: { gpu: '  Default ' } }, 'linux'), 'default');
  });
});

test('getVkTerminalsGpuMode: 未知の値は既定にフォールバックする', () => {
  withoutGpuEnv(() => {
    assert.equal(getVkTerminalsGpuMode({ vkTerminals: { gpu: 'turbo' } }, 'linux'), 'off');
    assert.equal(getVkTerminalsGpuMode({ vkTerminals: { gpu: '' } }, 'darwin'), 'default');
  });
});

test('getVkTerminalsGpuMode: env VK_TERMINALS_GPU が config.json より優先される', () => {
  withoutGpuEnv(() => {
    process.env.VK_TERMINALS_GPU = 'default';
    assert.equal(getVkTerminalsGpuMode({ vkTerminals: { gpu: 'off' } }, 'linux'), 'default');
  });
});

test('gpuLaunchOptions: off は GPU 無効フラグを返し追加 env は無し', () => {
  const { args, env } = gpuLaunchOptions('off');
  assert.deepEqual(args, ['--disable-gpu', '--disable-software-rasterizer']);
  assert.deepEqual(env, {});
});

test('gpuLaunchOptions: default はフラグ・env とも空（Chromium 任せ）', () => {
  const { args, env } = gpuLaunchOptions('default');
  assert.deepEqual(args, []);
  assert.deepEqual(env, {});
});

test('GPU_MODES: 取りうる値の一覧（off / default の2択）', () => {
  assert.deepEqual(GPU_MODES, ['off', 'default']);
});

test('buildSettingsDescriptor: VK Terminals グループに GPU モードの制約付きピッカーがある', () => {
  const desc = buildSettingsDescriptor('/tmp/config.json');
  const gpuField = desc.groups
    .flatMap((g) => g.fields ?? [])
    .find((f) => f.key === 'vkTerminals.gpu');
  assert.ok(gpuField);
  // 自由入力ではなく選択式（enum ピッカー）であること。
  assert.equal(gpuField.type, 'select');
  const optionValues = (gpuField.options ?? []).map((o) => o.value);
  // 空（自動）＋ getVkTerminalsGpuMode が受理する各モードが選択肢に含まれること。
  assert.deepEqual(optionValues, ['', 'off', 'default']);
  // 選択肢の値は空文字を除き GPU_MODES に一致する（silent な不正値を防ぐ）。
  for (const v of optionValues) {
    if (v !== '') assert.ok(GPU_MODES.includes(v), `未知のモード: ${v}`);
  }
});
