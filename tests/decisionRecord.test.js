/**
 * decision-record コメント解析（orchestrator/decision-record.js）のユニットテスト。
 *
 * vk-agents の rules/decision-record.md 書式（1 行目 `Comment by vk-agents`、
 * 2 行目 `Status: waiting-input` / `no-action` / `answered`）の読み取りと、
 * ユーザー返信検出・最新の指示待ち検出・ペイン経由解決（answered）検出を検証する。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDecisionRecordComment,
  isWaitingInputByAgent,
  isBotComment,
  isUserReply,
  findUserReply,
  findLatestWaitingInput,
  hasPendingWaitingInput,
  findReplyAfterWaitingInput,
  hasAgentAnsweredAfterWaitingInput,
  AGENT_MARKER,
} from '../src/engine/decision-record.js';

const agentWaitingInput = [
  'Comment by vk-agents',
  'Status: waiting-input',
  '',
  '**📋 司（ディレクター）からの報告**',
  '- A 案と B 案のどちらで進めるかご確認ください。',
].join('\n');

const agentNoAction = [
  'Comment by vk-agents',
  'Status: no-action',
  '',
  '- 設定の保存先を option に変更しました（記録のみ）。',
].join('\n');

const agentAnswered = [
  'Comment by vk-agents',
  'Status: answered',
  '',
  '- 先の確認はターミナルペインで直接回答いただき解決済みです（記録のみ）。',
].join('\n');

describe('parseDecisionRecordComment', () => {
  it('エージェントの waiting-input コメントを正しく解析する', () => {
    const r = parseDecisionRecordComment(agentWaitingInput);
    assert.equal(r.isAgentComment, true);
    assert.equal(r.status, 'waiting-input');
  });

  it('エージェントの no-action コメントを正しく解析する', () => {
    const r = parseDecisionRecordComment(agentNoAction);
    assert.equal(r.isAgentComment, true);
    assert.equal(r.status, 'no-action');
  });

  it('エージェントの answered コメントを正しく解析する', () => {
    const r = parseDecisionRecordComment(agentAnswered);
    assert.equal(r.isAgentComment, true);
    assert.equal(r.status, 'answered');
  });

  it('識別行が無いユーザー返信は isAgentComment=false / status=null', () => {
    const r = parseDecisionRecordComment('A 案でお願いします。');
    assert.equal(r.isAgentComment, false);
    assert.equal(r.status, null);
  });

  it('識別行はあるが Status 行が無い場合は status=null', () => {
    const r = parseDecisionRecordComment('Comment by vk-agents\n\n進捗報告です。');
    assert.equal(r.isAgentComment, true);
    assert.equal(r.status, null);
  });

  it('CRLF 改行・先頭空行・行末空白を含んでも識別できる', () => {
    const body = '\r\n  Comment by vk-agents  \r\nStatus: waiting-input  \r\n本文';
    const r = parseDecisionRecordComment(body);
    assert.equal(r.isAgentComment, true);
    assert.equal(r.status, 'waiting-input');
  });

  it('Status 行が 2 行目以外にあっても拾う', () => {
    const body = 'Comment by vk-agents\n\nいくつか判断が必要です。\nStatus: waiting-input';
    const r = parseDecisionRecordComment(body);
    assert.equal(r.status, 'waiting-input');
  });

  it('文章中に Status: という語があっても単独行でなければ拾わない', () => {
    const body = 'Comment by vk-agents\n\n現在の Status: waiting-input ではありません、という説明文。';
    const r = parseDecisionRecordComment(body);
    assert.equal(r.status, null);
  });

  it('未知の Status トークンは拾わない（旧 action-required を含む）', () => {
    assert.equal(parseDecisionRecordComment('Comment by vk-agents\nStatus: something-else').status, null);
    // 旧トークンはもう受理しない。
    assert.equal(parseDecisionRecordComment('Comment by vk-agents\nStatus: action-required').status, null);
  });

  it('空 / null / 非文字列は安全に false/null を返す', () => {
    for (const v of ['', null, undefined, 42, {}]) {
      const r = parseDecisionRecordComment(v);
      assert.equal(r.isAgentComment, false);
      assert.equal(r.status, null);
    }
  });

  it('識別行に余計な文字が付くと識別行とみなさない', () => {
    const r = parseDecisionRecordComment('> Comment by vk-agents\nStatus: waiting-input');
    assert.equal(r.isAgentComment, false);
  });
});

describe('isWaitingInputByAgent', () => {
  it('エージェント発 waiting-input のみ true', () => {
    assert.equal(isWaitingInputByAgent(agentWaitingInput), true);
    assert.equal(isWaitingInputByAgent(agentNoAction), false);
    // 識別行なしで Status だけ書かれていても（ユーザーの紛らわしい返信）true にしない
    assert.equal(isWaitingInputByAgent('Status: waiting-input'), false);
  });
});

describe('isBotComment', () => {
  it('user.type が Bot のコメントだけ true', () => {
    assert.equal(isBotComment({ user: { type: 'Bot' } }), true);
    assert.equal(isBotComment({ user: { type: 'User' } }), false);
    assert.equal(isBotComment({ body: 'x' }), false); // user 無し
    assert.equal(isBotComment(null), false);
    assert.equal(isBotComment(undefined), false);
  });
});

describe('isUserReply', () => {
  it('エージェント発でも bot 投稿でもないコメントだけ true', () => {
    assert.equal(isUserReply({ body: 'A 案で。', user: { type: 'User' } }), true);
    assert.equal(isUserReply({ body: 'A 案で。' }), true); // user 不明でも返信扱い
    assert.equal(isUserReply({ body: agentWaitingInput }), false); // 識別行あり
    assert.equal(
      isUserReply({ body: 'No actionable comments.', user: { type: 'Bot' } }),
      false,
    ); // CodeRabbit
  });

  it('null / undefined / 非オブジェクトは返信扱いしない', () => {
    assert.equal(isUserReply(null), false);
    assert.equal(isUserReply(undefined), false);
    assert.equal(isUserReply('A 案で。'), false); // 文字列は不正要素
  });
});

describe('findUserReply', () => {
  it('エージェントコメントを飛ばして最初の非エージェントコメントを返す', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'B 案でお願いします。' },
      { id: 3, body: '追記です。' },
    ];
    assert.equal(findUserReply(comments)?.id, 2);
  });

  it('非エージェントコメントが無ければ null', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: agentNoAction },
    ];
    assert.equal(findUserReply(comments), null);
  });

  it('bot 判定は本文ではなく user.type で行う（識別行なしでも user 不明なら返信扱い）', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'No actionable comments.' }, // user.type が無いので返信扱いのまま
    ];
    assert.equal(findUserReply(comments)?.id, 2);
  });

  it('user.type が Bot のコメント（CodeRabbit 等）は返信扱いせず飛ばす', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'No actionable comments.', user: { type: 'Bot' } }, // CodeRabbit
      { id: 3, body: 'A 案で。', user: { type: 'User' } },
    ];
    assert.equal(findUserReply(comments)?.id, 3);
  });

  it('bot コメントしか無ければ null', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'auto-generated comment', user: { type: 'Bot' } },
    ];
    assert.equal(findUserReply(comments), null);
  });

  it('配列でなければ null', () => {
    assert.equal(findUserReply(null), null);
    assert.equal(findUserReply(undefined), null);
  });
});

describe('findLatestWaitingInput', () => {
  it('最新（末尾側）の waiting-input エージェントコメントを返す', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'A 案で。' },
      { id: 3, body: agentNoAction },
      { id: 4, body: agentWaitingInput },
    ];
    assert.equal(findLatestWaitingInput(comments)?.id, 4);
  });

  it('waiting-input が無ければ null', () => {
    const comments = [
      { id: 1, body: agentNoAction },
      { id: 2, body: 'ふつうのコメント' },
    ];
    assert.equal(findLatestWaitingInput(comments), null);
  });
});

describe('hasPendingWaitingInput', () => {
  it('waiting-input の後に返信が無ければ true', () => {
    const comments = [
      { id: 1, body: agentNoAction },
      { id: 2, body: agentWaitingInput },
    ];
    assert.equal(hasPendingWaitingInput(comments), true);
  });

  it('waiting-input の後にユーザー返信があれば false（応答済み）', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'A 案で。' },
    ];
    assert.equal(hasPendingWaitingInput(comments), false);
  });

  it('返信→再確認のサイクルに追従する（最後が未応答の確認なら true）', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'A 案で。' },          // 1回目応答
      { id: 3, body: agentNoAction },         // 記録（pending 不変）
      { id: 4, body: agentWaitingInput },   // 2回目の確認、未応答
    ];
    assert.equal(hasPendingWaitingInput(comments), true);
  });

  it('最後がユーザー返信なら false', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: agentWaitingInput },
      { id: 3, body: 'まとめて B でお願いします。' },
    ];
    assert.equal(hasPendingWaitingInput(comments), false);
  });

  it('no-action だけなら false（確認ではない）', () => {
    assert.equal(hasPendingWaitingInput([{ id: 1, body: agentNoAction }]), false);
  });

  it('waiting-input の後にエージェント発 answered があれば false（ペイン経由で解決済み）', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: agentAnswered },        // 司がペイン経由で解決を明示宣言
    ];
    assert.equal(hasPendingWaitingInput(comments), false);
  });

  it('waiting-input → answered → 再度 waiting-input なら true（再質問は待ち直す）', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: agentAnswered },         // 1回目はペイン経由で解決
      { id: 3, body: agentWaitingInput },   // 2回目の確認、未応答
    ];
    assert.equal(hasPendingWaitingInput(comments), true);
  });

  it('answered 単独（先行 waiting-input 無し）なら false', () => {
    assert.equal(hasPendingWaitingInput([{ id: 1, body: agentAnswered }]), false);
  });

  it('waiting-input の後に無関係な no-action 報告が割り込んでも true のまま（安全側設計の回帰）', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: agentNoAction },         // no-action は pending を変えない
    ];
    assert.equal(hasPendingWaitingInput(comments), true);
  });

  it('waiting-input の後の bot コメント（CodeRabbit 等）は応答とみなさず true のまま', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'No actionable comments.', user: { type: 'Bot' } }, // CodeRabbit
    ];
    assert.equal(hasPendingWaitingInput(comments), true);
  });

  it('bot コメントの後に本物のユーザー返信があれば false', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'auto-generated comment', user: { type: 'Bot' } },
      { id: 3, body: 'A 案で。', user: { type: 'User' } },
    ];
    assert.equal(hasPendingWaitingInput(comments), false);
  });

  it('空・非配列は false', () => {
    assert.equal(hasPendingWaitingInput([]), false);
    assert.equal(hasPendingWaitingInput(null), false);
  });
});

describe('findReplyAfterWaitingInput', () => {
  it('最後の waiting-input より後の最初の非エージェントコメントを返す', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: '1回目の返信' },
      { id: 3, body: agentWaitingInput },
      { id: 4, body: '2回目の返信' },
      { id: 5, body: '追記' },
    ];
    assert.equal(findReplyAfterWaitingInput(comments)?.id, 4);
  });

  it('waiting-input の後に返信がまだ無ければ null', () => {
    const comments = [
      { id: 1, body: '雑談' },
      { id: 2, body: agentWaitingInput },
    ];
    assert.equal(findReplyAfterWaitingInput(comments), null);
  });

  it('waiting-input が無ければ null', () => {
    assert.equal(findReplyAfterWaitingInput([{ id: 1, body: agentNoAction }]), null);
  });

  it('user.type が無ければ返信として返す（bot 判定は本文ではしない）', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'No actionable comments.' },
    ];
    assert.equal(findReplyAfterWaitingInput(comments)?.id, 2);
  });

  it('waiting-input の後の bot コメント（CodeRabbit 等）は転送対象にしない', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'No actionable comments.', user: { type: 'Bot' } }, // CodeRabbit
    ];
    assert.equal(findReplyAfterWaitingInput(comments), null);
  });

  it('bot コメントを飛ばして本物のユーザー返信を返す', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'auto-generated comment', user: { type: 'Bot' } },
      { id: 3, body: 'B 案で。', user: { type: 'User' } },
    ];
    assert.equal(findReplyAfterWaitingInput(comments)?.id, 3);
  });
});

describe('hasAgentAnsweredAfterWaitingInput', () => {
  it('最新の waiting-input の後にエージェント発 answered があれば true', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: agentAnswered },
    ];
    assert.equal(hasAgentAnsweredAfterWaitingInput(comments), true);
  });

  it('waiting-input → answered → さらに waiting-input なら false（最新 WI は未解決）', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: agentAnswered },
      { id: 3, body: agentWaitingInput },   // 再質問。この後に answered は無い
    ];
    assert.equal(hasAgentAnsweredAfterWaitingInput(comments), false);
  });

  it('waiting-input の後に非エージェント返信のみ（answered 無し）なら false', () => {
    const comments = [
      { id: 1, body: agentWaitingInput },
      { id: 2, body: 'A 案で。' },
    ];
    assert.equal(hasAgentAnsweredAfterWaitingInput(comments), false);
  });

  it('waiting-input が無ければ false（answered 単独でも false）', () => {
    assert.equal(hasAgentAnsweredAfterWaitingInput([{ id: 1, body: agentAnswered }]), false);
    assert.equal(hasAgentAnsweredAfterWaitingInput([{ id: 1, body: agentNoAction }]), false);
  });

  it('空配列 / null は false', () => {
    assert.equal(hasAgentAnsweredAfterWaitingInput([]), false);
    assert.equal(hasAgentAnsweredAfterWaitingInput(null), false);
  });
});

describe('AGENT_MARKER', () => {
  it('識別行の定数を公開している', () => {
    assert.equal(AGENT_MARKER, 'Comment by vk-agents');
  });
});
