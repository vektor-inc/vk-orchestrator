import { createServer } from 'net';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkHealth,
  evaluateHealthInstance,
  fetchHealth,
  findFreePort,
} from '../src/terminals/index.js';

const PORT = 13847;

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('findFreePort: 使用可能な数値ポートを返す', async () => {
  const port = await findFreePort('127.0.0.1');
  assert.equal(Number.isInteger(port), true);
  assert.equal(port > 0 && port <= 65535, true);

  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
});

test('fetchHealth: health の ok と instanceId を返す', async () => {
  global.fetch = async () => ({
    json: async () => ({ ok: true, instanceId: 'instance-1' }),
  });

  assert.deepEqual(await fetchHealth(PORT), { ok: true, instanceId: 'instance-1' });
  assert.equal(await checkHealth(PORT), true);
});

test('evaluateHealthInstance: instanceId が一致すれば続行する', () => {
  assert.deepEqual(
    evaluateHealthInstance({ ok: true, instanceId: 'expected-id' }, 'expected-id'),
    { ok: true, mode: 'matched', instanceId: 'expected-id' },
  );
});

test('evaluateHealthInstance: instanceId が不一致なら中断する', () => {
  assert.deepEqual(
    evaluateHealthInstance({ ok: true, instanceId: 'other-id' }, 'expected-id'),
    { ok: false, reason: 'instance-mismatch', instanceId: 'other-id' },
  );
});

test('evaluateHealthInstance: instanceId が無い旧 VK Terminals は後方互換で続行する', () => {
  assert.deepEqual(
    evaluateHealthInstance({ ok: true }, 'expected-id'),
    { ok: true, mode: 'legacy' },
  );
});

