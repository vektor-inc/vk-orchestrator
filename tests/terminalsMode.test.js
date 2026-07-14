import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERMINALS_MODES,
  resolveTerminalsMode,
  resolveTmuxSession,
  resolveTmuxClaudeCommand,
} from '../src/config.js';

const ENV_KEYS = ['VK_TERMINALS_MODE', 'VK_TMUX_SESSION', 'VK_TMUX_CLAUDE_CMD'];
let saved;
beforeEach(() => { saved = {}; for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

test('resolveTerminalsMode: 既定は vk-terminals', () => {
  assert.equal(resolveTerminalsMode({}), 'vk-terminals');
});
test('resolveTerminalsMode: config で tmux', () => {
  assert.equal(resolveTerminalsMode({ terminals: { mode: 'tmux' } }), 'tmux');
});
test('resolveTerminalsMode: env が config より優先', () => {
  process.env.VK_TERMINALS_MODE = 'tmux';
  assert.equal(resolveTerminalsMode({ terminals: { mode: 'vk-terminals' } }), 'tmux');
});
test('resolveTerminalsMode: 未知値は既定へフォールバック', () => {
  assert.equal(resolveTerminalsMode({ terminals: { mode: 'bogus' } }), 'vk-terminals');
});
test('TERMINALS_MODES は vk-terminals と tmux', () => {
  assert.deepEqual(TERMINALS_MODES, ['vk-terminals', 'tmux']);
});
test('resolveTmuxSession: 既定 vk-orch / env 優先', () => {
  assert.equal(resolveTmuxSession({}), 'vk-orch');
  process.env.VK_TMUX_SESSION = 'foo';
  assert.equal(resolveTmuxSession({ tmux: { session: 'bar' } }), 'foo');
});
test('resolveTmuxClaudeCommand: 既定 claude / config 反映', () => {
  assert.equal(resolveTmuxClaudeCommand({}), 'claude');
  assert.equal(resolveTmuxClaudeCommand({ tmux: { claudeCommand: 'claude --dangerously-skip-permissions' } }),
    'claude --dangerously-skip-permissions');
});
