---
name: staff-security
description: "リードエンジニア（安藤保）をサブエージェントとして起動する。コード品質・レビューの最終責任者。設計・可読性・保守性・パフォーマンス・セキュリティの全般をレビュー。「安藤さん」「保さん」で呼び出し可能。"
---

# /staff-security スキル

> **前提条件（硬ゲート）:** このスキルは、対象リポジトリの owner が許可リスト `org.allowed_owners`（`~/.claude/vk-agents-settings.json`）に含まれる場合のみ使用できます。判定手順は `rules/repository-access.md` を参照してください（許可リスト未設定時は確認のうえ続行可）。

安藤保（リードエンジニア / コード品質・レビューの最終責任者）をサブエージェントとして起動します。

## 手順

1. `Read` ツールで以下のペルソナファイルを読み込む:
   - `REPO_ROOT/skills/staff-security/persona.md`

2. `Agent` ツール（subagent_type: `general-purpose`）で安藤を起動する。
   prompt には以下を含める:
   - persona.md の内容（安藤のペルソナ・役割・参照スキル）
   - ユーザーからの依頼内容: `$ARGUMENTS`

3. サブエージェントの回答をそのままユーザーに返す。

## 他エージェントから安藤を呼ぶ方法

ディレクター・エンジニア等のエージェントが安藤にセキュリティレビューを依頼したい場合は、
以下の手順で `Agent` ツールを呼んでください:

```
1. Read で REPO_ROOT/skills/staff-security/persona.md を読む
2. Agent ツール（subagent_type: general-purpose）を起動
3. prompt = persona.md の内容 + レビュー依頼内容（PR URL・対象コード等）
```
