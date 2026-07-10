/**
 * redactSecrets のユニットテスト（issue #126 / CWE-200 対策）。
 *
 * 端末出力を公開リポジトリの issue / PR に貼る前に通すマスキング純粋関数の検証。
 *
 * 検証観点:
 *   - GitHub トークン（classic ghp_ 等 / fine-grained github_pat_）を伏字化する
 *   - AWS アクセスキー ID（AKIA...）を伏字化する
 *   - Authorization: Bearer トークンを伏字化する
 *   - Slack トークン（xoxb- 等）を伏字化する
 *   - git remote URL 内の x-access-token を伏字化する
 *   - Anthropic API キー（sk-ant-）を伏字化する
 *   - PEM 秘密鍵ブロック（BEGIN〜END）をまるごと伏字化する
 *   - END が欠けた途中までの PEM ブロックも BEGIN 以降を伏字化する
 *   - 複数の秘匿情報が混在しても全て伏字化する
 *   - 秘匿情報を含まない通常テキストはそのまま返す
 *   - null / undefined はそのまま返す
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets, REDACTED } from '../src/engine/redact-secrets.js';

describe('redactSecrets', () => {
  it('GitHub classic トークン（ghp_）を伏字化する', () => {
    const out = redactSecrets('token=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    assert.equal(out, `token=${REDACTED}`);
    assert.ok(!out.includes('ghp_abcdef'));
  });

  it('GitHub fine-grained PAT（github_pat_）を伏字化する', () => {
    const secret = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789';
    const out = redactSecrets(`export GH=${secret}`);
    assert.equal(out, `export GH=${REDACTED}`);
  });

  it('AWS アクセスキー ID（AKIA...）を伏字化する', () => {
    const out = redactSecrets('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    assert.equal(out, `AWS_ACCESS_KEY_ID=${REDACTED}`);
  });

  it('AWS STS 一時アクセスキー（ASIA...）を伏字化する', () => {
    const out = redactSecrets('AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE');
    assert.equal(out, `AWS_ACCESS_KEY_ID=${REDACTED}`);
  });

  it('Authorization Bearer トークンを伏字化する', () => {
    const out = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456');
    assert.equal(out, `Authorization: ${REDACTED}`);
    assert.ok(!out.includes('Bearer'));
  });

  it('Slack トークン（xoxb-）を伏字化する', () => {
    const out = redactSecrets('SLACK=' + ['xoxb', '1234567890', 'ABCDEFGHIJKLMN'].join('-'));
    assert.equal(out, `SLACK=${REDACTED}`);
  });

  it('git remote URL 内の x-access-token を token 部分だけ伏字化する', () => {
    const out = redactSecrets('https://x-access-token:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/owner/repo.git');
    assert.equal(out, `https://x-access-token:${REDACTED}@github.com/owner/repo.git`);
  });

  it('Anthropic API キー（sk-ant-）を伏字化する', () => {
    const out = redactSecrets('ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN');
    assert.equal(out, `ANTHROPIC_API_KEY=${REDACTED}`);
  });

  it('PEM 秘密鍵ブロック（BEGIN〜END）をまるごと伏字化する', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ0987654321',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`鍵:\n${pem}\nおわり`);
    assert.equal(out, `鍵:\n${REDACTED}\nおわり`);
    assert.ok(!out.includes('MIIEpAIBAAKCAQEA'));
    assert.ok(!out.includes('BEGIN'));
  });

  it('END が欠けた途中までの PEM ブロックも BEGIN 以降を伏字化する', () => {
    const out = redactSecrets('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg途中で切れた');
    assert.equal(out, REDACTED);
    assert.ok(!out.includes('MIIEvQIBAD'));
  });

  it('複数の秘匿情報が混在しても全て伏字化する', () => {
    const input = 'gh: ghp_abcdefghijklmnopqrstuvwxyz0123456789 / aws: AKIAIOSFODNN7EXAMPLE';
    const out = redactSecrets(input);
    assert.equal(out, `gh: ${REDACTED} / aws: ${REDACTED}`);
  });

  it('秘匿情報を含まない通常テキストはそのまま返す', () => {
    const input = '? for help\n> y/n で続行しますか？\nファイル app.js を編集しました';
    assert.equal(redactSecrets(input), input);
  });

  it('null / undefined はそのまま返す', () => {
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(undefined), undefined);
  });
});
