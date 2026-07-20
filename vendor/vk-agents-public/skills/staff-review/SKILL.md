---
name: staff-review
description: "e2eテスト・UIテスト担当（麗美）をサブエージェントとして起動する。PRに対してPlaywrightでブラウザ操作テストを実施する。コードレビューはスコープ外。"
---

# /staff-review スキル

> **前提条件（硬ゲート）:** 対象リポジトリの owner が許可リスト `org.allowed_owners`（`~/.vk-agents/config.json`）に含まれる場合のみ使用できます。判定は `rules/repository-access.md` を参照してください（許可リスト未設定時は確認のうえ続行可）。

麗美（レビュアー）をサブエージェントとして起動します。

## 手順

1. `Read` ツールで以下のペルソナファイルを読む:
   - `REPO_ROOT/skills/staff-review/persona.md`

2. `Agent` ツール（subagent_type: `general-purpose`）で麗美を起動する。
   prompt に含める:
   - persona.md の内容（麗美のペルソナ・役割・スコープ・トーン）
   - 以下「レビュー手順」セクションの全内容
   - ユーザーからの依頼内容: `$ARGUMENTS`

3. 回答をそのままユーザーに返す。

## 他エージェントから麗美を呼ぶ方法

ディレクター・エンジニア等が麗美にレビューを依頼する場合は、以下で `Agent` ツールを呼ぶ:

```
1. Read で REPO_ROOT/skills/staff-review/persona.md を読む
2. Agent ツール（subagent_type: general-purpose）を起動
3. prompt = persona.md の内容 + 以下「レビュー手順」の全内容 + レビュー依頼内容（PR URL 等）
```

## レビュー手順

### ステップ0: ルールファイルの読み込み

レビュー前に以下を **必ず `Read` ツールで読む**:

- `rules/design-rules.md`
- `vendor/ui-ux-pro-max-skill/.claude/skills/ui-ux-pro-max/SKILL.md`（UI/UX Pro Max ガイドライン）
  - サブモジュール `vendor/ui-ux-pro-max-skill` 内のため、**存在する場合のみ** `Read` で読む。無ければスキップしてよい。
- `rules/testing/e2e.md`

### ステップ1: PR の変更内容を把握する

1. `gh pr view <PR番号> --repo <owner/repo> --json title,body,files` で PR 概要・変更ファイルを確認する
2. `gh pr diff <PR番号> --repo <owner/repo>` で差分を確認し、**ブラウザで何を確認すべきか**を洗い出す
3. PR 本文に「確認手順」があればそれに従う

### ステップ2: テスト環境の準備

1. **PR ブランチのチェックアウト**:
   ```
   cd <リポジトリのパス>
   gh pr checkout <PR番号>
   ```

2. **依存パッケージのインストール**（必要に応じて）:
   ```
   npm install
   composer install  # composer.json がある場合
   ```

3. **wp-env の起動**（リポジトリルートで）:
   ```
   npx wp-env start
   ```
   - デフォルトで `http://localhost:8889` でアクセス可能
   - `.wp-env.json` / `.wp-env.override.json` がある場合はそのポート設定に従う
   - ログイン情報: `admin` / `password`

4. **テストデータのセットアップ**:
   - `tests/e2e/sql/` ディレクトリにテスト用SQLがある場合はインポートする:
     ```
     npx wp-env run cli wp db import tests/e2e/sql/<ファイル名>.sql
     ```
   - SQLがない場合は wp-cli で必要なデータ（投稿・カテゴリー・タグ等）を作成する
   - 作成後、他のテストで使い回せるようSQLをエクスポートする:
     ```
     npx wp-env run cli wp db export tests/e2e/sql/<テスト名>.sql
     ```

5. **Playwright のインストール確認**:
   ```
   npx playwright install chromium
   ```

### ステップ3: テストの作成と実行

ブラウザは headless（非表示）で実行する。詳細は `rules/testing/e2e.md` の「ブラウザは headless（非表示）で実行する」参照。

1. 既存テストがある場合はまず実行する:
   ```
   # WordPress Scripts 統合型の場合
   npx wp-scripts test-playwright

   # Pure Playwright の場合
   npx playwright test
   ```

2. PR の変更内容から、ブラウザ確認すべき操作シナリオを洗い出す

3. テストを作成する:
   - `@wordpress/e2e-test-utils-playwright` を使っているプロジェクト → 同じパターンで書く
   - それ以外 → Pure Playwright で書く
   - テストファイルは既存ディレクトリ構造に合わせて配置する
   - コード例・ベースURLのルールは `rules/testing/e2e.md` を参照する

4. テストを実行する:
   ```
   npx playwright test <テストファイルパス>
   ```

5. 失敗した場合はスクリーンショット・トレースを確認し、問題を特定する

### ステップ4: before/after スクリーンショットの撮影と投稿

UI や表示に関わる変更で実施する（ロジックのみの修正では不要）。
ブラウザは headless（非表示）で実行する。詳細は `rules/testing/e2e.md` の「ブラウザは headless（非表示）で実行する」参照。

1. **before（PR のベースブランチ）**:
   ```
   git checkout "$(gh pr view <PR番号> --repo <owner/repo> --json baseRefName --jq .baseRefName)"
   npx wp-env start
   ```
   Playwright で対象ページのスクリーンショットを撮影し、ローカル保存する。

2. **after（PR ブランチ）**:
   ```
   gh pr checkout <PR番号>
   npx wp-env start
   ```
   同じページのスクリーンショットを撮影し、ローカル保存する。

3. スクリーンショットの保存先・ディレクトリ構成は `rules/testing/e2e.md` の「スクリーンショットの保存先」を参照する。

### ステップ5: 回帰確認

- 変更に関連する既存機能が壊れていないことを確認する
- 既存の e2e テストがすべて PASS することを確認する

### ステップ6: PR コメントの投稿

`rules/testing/e2e.md` の「テスト報告テンプレート」に従って PR にコメントを投稿する。

### ステップ7: 結果に応じた対応

まず `gh pr view <PR番号> --repo <owner/repo> --json author` で PR 作成者を確認する。

#### PASS の場合

司（ディレクター）に「テスト完了、問題なし」と報告する。

#### FAIL の場合

- **PR 作成者が和田の場合**: 和田に具体的な問題点と修正依頼を伝える。修正後に再テストを実施する。
- **PR 作成者が和田以外の場合**: ユーザーに「テストで問題が見つかったが、対応をどうするか」を確認する。

## 失敗時の対応

ステップ2の環境構築コマンド（`npm install` / `composer install` / `npx wp-env start` / `npx playwright install chromium`）が失敗した場合は、テストを進めず以下を確認し、解決できなければ司／ユーザーにエスカレーションする。

- **ポート衝突で wp-env が起動しない**: `npx wp-env stop` してから再起動するか、既存プロセスが該当ポートを占有していないか確認する。
- **依存インストールが失敗**（`npm install` / `composer install`）: エラー出力を確認し、Node/PHP バージョンや lockfile の不整合を確認する。
- **同一エラーで累計2〜3回失敗した場合は打ち切る**（vk-bot-pr の打ち切り目安に準拠）。それ以上リトライせず、エラー要点を添えて司／ユーザーにエスカレーションする。
- **e2e テスト環境が立ち上がらない場合**: 報告に「テスト未実施」を明記する。環境が無いまま PASS と誤報告してはならない。
