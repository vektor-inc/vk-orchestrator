import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTmuxBackend } from '../src/terminals/backend-tmux.js';

// tmux 実行を差し替えるフェイク。呼ばれた args を記録し、指定した stdout を返す。
function fakeRunner(responses = {}) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = args.join(' ');
    for (const [prefix, out] of Object.entries(responses)) {
      if (key.startsWith(prefix)) return { status: 0, stdout: out, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('createNewPane: new-window で window_id を作り termId に返す', async () => {
  const { run, calls } = fakeRunner({ 'new-window': '@3\n' });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  const termId = await be.createNewPane(0, '/work/dir', {});
  assert.equal(termId, '@3');
  const nw = calls.find(a => a.includes('new-window'));
  assert.ok(nw.includes('-t') && nw.includes('vk-orch'));
  assert.ok(nw.includes('-c') && nw.includes('/work/dir'));
  assert.ok(nw.join(' ').includes('claude')); // claudeCommand を起動
});

test('createNewPane: noClaude なら claude を起動しない', async () => {
  const { run, calls } = fakeRunner({ 'new-window': '@4\n' });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, { noClaude: true });
  const nw = calls.find(a => a.includes('new-window'));
  assert.ok(!nw.join(' ').includes('claude'));
});

test('sendToTerminal: \\r は Enter、本文はリテラル送信', async () => {
  const { run, calls } = fakeRunner();
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.sendToTerminal(0, '@3', 'hello world');
  await be.sendToTerminal(0, '@3', '\r');
  const literal = calls.find(a => a.includes('-l'));
  assert.deepEqual(literal, ['send-keys', '-t', '@3', '-l', '--', 'hello world']);
  const enter = calls.find(a => a.includes('Enter'));
  assert.deepEqual(enter, ['send-keys', '-t', '@3', 'Enter']);
});

test('getStates: 生成済みペインのみ、lastOutputTime は ms', async () => {
  const { run } = fakeRunner({
    'new-window': '@3\n',
    'list-windows': '@3 1000\n@9 1000\n',   // @9 は追跡外 → 報告しない
    'capture-pane': 'line1\nline2\n',
  });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, {});
  const { terminals } = await be.getStates(0);
  const ids = Object.keys(terminals);
  assert.deepEqual(ids, ['@3']);
  assert.equal(terminals['@3'].termId, '@3');
  assert.equal(terminals['@3'].lastOutputTime, 1000 * 1000);
  assert.match(terminals['@3'].lastLines, /line2/);
  assert.equal(terminals['@3'].waiting, false);
});

test('setExternalWaiting: getStates に反映される往復ストア', async () => {
  const { run } = fakeRunner({ 'new-window': '@3\n', 'list-windows': '@3 5\n', 'capture-pane': 'x\n' });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, {});
  await be.setExternalWaiting(0, '@3', true);
  const { terminals } = await be.getStates(0);
  assert.equal(terminals['@3'].waiting, true);
});

test('checkHealth: has-session の status 0 で true', async () => {
  const run = (args) => args.includes('has-session') ? { status: 0, stdout: '', stderr: '' } : { status: 1, stdout: '', stderr: '' };
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  assert.equal(await be.checkHealth(0), true);
});

test('setTerminalPrUrl / postMenu は no-op で {ok:true}', async () => {
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.deepEqual(await be.setTerminalPrUrl(0, '@3', 'http://x'), { ok: true });
  assert.deepEqual(await be.postMenu(0, {}), { ok: true });
});

test('setTerminalTitle: rename-window は -- でタイトルを保護し、空タイトルなら呼ばない', async () => {
  const { run, calls } = fakeRunner();
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.setTerminalTitle(0, '@3', '-danger');
  const rn = calls.find(a => a.includes('rename-window'));
  assert.deepEqual(rn, ['rename-window', '-t', '@3', '--', '-danger']);

  calls.length = 0;
  await be.setTerminalTitle(0, '@3', '');
  assert.equal(calls.find(a => a.includes('rename-window')), undefined);
});

test('getStates: list-windows から消えた window は panes から除去され、以後も正しく振る舞う', async () => {
  const calls = [];
  let listWindowsOut = '@3 1000\n';
  const run = (args) => {
    calls.push(args);
    const key = args.join(' ');
    if (key.startsWith('new-window')) return { status: 0, stdout: '@3\n', stderr: '' };
    if (key.startsWith('list-windows')) return { status: 0, stdout: listWindowsOut, stderr: '' };
    if (key.startsWith('capture-pane')) return { status: 0, stdout: 'line1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, {});

  // 1回目: window は存在する → 報告される
  let { terminals } = await be.getStates(0);
  assert.deepEqual(Object.keys(terminals), ['@3']);

  // 2回目: list-windows から消えた → 報告されず、内部 panes からも除去される
  listWindowsOut = '';
  ({ terminals } = await be.getStates(0));
  assert.deepEqual(Object.keys(terminals), []);

  // 3回目: 同じ window id が再度 list-windows に現れても、panes からは既に除去されているため無視される
  // （tmux の window id は再利用されないため、実運用では起こらないが pane リークが無いことの確認）
  listWindowsOut = '@3 2000\n';
  ({ terminals } = await be.getStates(0));
  assert.deepEqual(Object.keys(terminals), []);
});

test('getStates: window_activity が 0 のとき lastOutputTime は epoch(0) ではなく現在時刻', async () => {
  const { run } = fakeRunner({
    'new-window': '@3\n',
    'list-windows': '@3 0\n',
    'capture-pane': 'line1\n',
  });
  const be = createTmuxBackend({ session: 'vk-orch', claudeCommand: 'claude', run });
  await be.createNewPane(0, null, {});
  const { terminals } = await be.getStates(0);
  const t = terminals['@3'].lastOutputTime;
  assert.ok(Math.abs(Date.now() - t) < 60000);
});
