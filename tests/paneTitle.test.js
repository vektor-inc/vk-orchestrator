/**
 * buildPaneTitleSequence / setOwnPaneTitle のユニットテスト（issue #157）。
 *
 * orchestrator（npm start）が自分自身の VK Terminals ペインタイトルを
 * OSC 0 エスケープシーケンスで設定する挙動を検証する:
 *
 *   - OSC 0 + BEL 終端のシーケンスを組み立てること
 *   - タイトル中の制御文字（BEL/ESC 等）を除去してシーケンスを壊さないこと
 *   - stdout が TTY のときだけ書き込み、非 TTY ではスキップすること
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildPaneTitleSequence, setOwnPaneTitle } from '../src/terminals/index.js';

describe('buildPaneTitleSequence', () => {
  it('OSC 0 + BEL 終端でタイトルを包む', () => {
    assert.equal(buildPaneTitleSequence('オーケストレーター'), '\x1b]0;オーケストレーター\x07');
  });

  it('制御文字（ESC/BEL/改行）を除去する', () => {
    const input = 'オーケ\x1b]0;evil\x07レー\nター';
    const out = buildPaneTitleSequence(input);
    // 先頭の OSC 開始と末尾の BEL を除いた本文に制御文字が残っていないこと
    const body = out.slice('\x1b]0;'.length, -1);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\x00-\x1f\x7f]/.test(body), `制御文字が残存: ${JSON.stringify(body)}`);
    assert.equal(body, 'オーケ]0;evilレーター');
  });

  it('C1 制御文字（8bit OSC/ST 等）も除去する', () => {
    // \x9d は 8bit OSC、\x9c は 8bit ST。これらを残すと一部端末でブレイクアウトしうる
    const out = buildPaneTitleSequence('オーケ\x9d0;evil\x9cター');
    const body = out.slice('\x1b]0;'.length, -1);
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\x80-\x9f]/.test(body), `C1 制御文字が残存: ${JSON.stringify(body)}`);
    assert.equal(body, 'オーケ0;evilター');
  });

  it('文字列以外も文字列化して扱う', () => {
    assert.equal(buildPaneTitleSequence(123), '\x1b]0;123\x07');
  });
});

describe('setOwnPaneTitle', () => {
  it('TTY のとき OSC シーケンスを書き込み true を返す', () => {
    const written = [];
    const fakeTty = { isTTY: true, write: (s) => written.push(s) };
    const result = setOwnPaneTitle('オーケストレーター', fakeTty);
    assert.equal(result, true);
    assert.deepEqual(written, ['\x1b]0;オーケストレーター\x07']);
  });

  it('非 TTY のときは何も書き込まず false を返す', () => {
    const written = [];
    const fakePipe = { isTTY: false, write: (s) => written.push(s) };
    const result = setOwnPaneTitle('オーケストレーター', fakePipe);
    assert.equal(result, false);
    assert.deepEqual(written, []);
  });

  it('stream が無い場合も false を返して落ちない', () => {
    assert.equal(setOwnPaneTitle('オーケストレーター', null), false);
    assert.equal(setOwnPaneTitle('オーケストレーター', undefined), false);
  });
});
