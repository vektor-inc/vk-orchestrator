> **注意:** このファイルは https://github.com/vektor-inc/vk-agents で管理されています。内容を変更する場合は、このファイルを直接編集せず、元リポジトリの方で変更してください。

> **スキル連携:** このファイルは `skills/vk-pr/SKILL.md` から参照されています。Claude Code（.claude）環境では `/vk-pr` コマンドで本ルールに従った PR 作成を実行できます。CodeRabbit 監視・CI 起動は呼び出し元エージェント（通常は司 = `/vk-kore`）の責務です（手順は [coderabbit-monitoring.md](coderabbit-monitoring.md) を参照）。

# プルリクエストのルール

このファイルには判断基準・手順のみをまとめています。確認手順テンプレート・記載例の詳細は [pull-request-examples.md](pull-request-examples.md) を参照してください。

## PR 作成前の確認

### ブランチの確認

`git branch --show-current` で現在のブランチを確認してください。

- **main / master ブランチにいる場合**: 変更内容に応じた適切なブランチ名で新しいブランチを作成する（`git checkout -b <ブランチ名>`）
- **すでに作業ブランチにいる場合**: そのまま次の手順に進む

### コーディングルールの確認

PHP・JS などプログラムファイルの変更が含まれる場合、`coding-rules.md` を Read で読み込み、変更内容がルールに沿っているか確認してください。問題があれば修正してから PR を作成してください。

特に **コメントの記載言語**（`coding-rules.md` の「コメント言語」）は見落とされやすいため、必ず確認してください。対象プロジェクトの `readme.txt` の有無・言語から記載言語を判定し（判定基準は `coding-rules.md` を唯一の正とする）、**日本語のみと判定されるプロジェクトのコメントに英語を併記していないか**（逆に英日併記プロジェクトで片方を欠いていないか）を、追加・変更したコメントについて照合してください。違反があれば PR 作成前に修正します。

### デザインルールの確認

CSS・SCSS などデザイン関連ファイルの変更が含まれる場合、`design-rules.md` および `css.md` を Read で読み込み、変更内容がルールに沿っているか確認してください。問題があれば修正してから PR を作成してください。

### PHPUnit テストの確認

PR に PHP の関数・メソッドの追加が含まれる場合、対応する PHPUnit テストが存在するか確認してください。

- テストが存在しない場合、ユーザーに追加を促してください。
- ただし、以下のケースではテストを書かないことも許容されます。
  - WordPress のフック・フィルターのみを扱う処理など、単体テストになじまない実装
  - テスト環境の制約でテスト不可能な処理
- テストを書かない場合は、その理由をユーザーに確認した上で PR 作成に進んでください。

## タイトルと概要

- PR の概要（description）は日本語で記載してください。
- **PR タイトルの記載ルール（分類・ブロック名・体言止め・原因→結果・記載言語など）は [change-title.md](change-title.md) を参照してください。** changelog の各行と PR タイトルは同じ書式で記載します。

## 元 issue の参照

PR 本文には、対応する元 issue を orchestrator が紐付けられる形式で参照する行を必ず 1 行含めてください。orchestrator（vk-orchestrator）が PR を issue に紐付ける形式は **完全 URL**（例: `関連 issue: https://github.com/vektor-inc/vk-agents/issues/203`）、または **クローズキーワード（close/fix/resolve 系）+ `#N`** のいずれかで、裸の `#N` だけでは紐付かず PR リンク表示・PR URL 追記・done ゲート・automerge が機能しません。ただしクローズキーワードは GitHub の自動クローズを誘発し、task-queue 経由で orchestrator が issue クローズ責務を持つ構成と競合しうるため、**自動クローズを誘発しない完全 URL 参照（`関連 issue: <完全 URL>` の 1 行）を推奨します**。

## changelog の確認と記載

PR作成前に、以下の手順で changelog を確認・更新してください。詳細なルールは [changelog.md](changelog.md) を参照してください。

### 1. changelog ファイルの特定

[changelog.md](changelog.md) の「記載対象ファイル」に従って対象ファイルを特定する。

### 2. 既存 changelog の言語確認

changelog ファイルを `Read` で読み込み、[changelog.md](changelog.md) の「記載言語」に従って記載言語を決める。

### 3. changelog の記載有無を確認

変更内容が changelog に記載されているか確認してください。

- **記載されている場合**: [changelog.md](changelog.md) と [change-title.md](change-title.md) のルールに従っているか確認。従っていない場合は修正。
- **記載されていない場合**: [changelog.md](changelog.md) と [change-title.md](change-title.md) のルールに従って changelog を追記してから PR 作成に進む

エントリを追記する際は、先頭に積むのではなく [change-title.md](change-title.md) の「分類の並び順」に従って、未リリースのエントリ群の中でその分類のグループに収まる位置へ挿入してください（判定基準は change-title.md / changelog.md を唯一の正とする）。

### 4. 記載内容のセルフチェック・自動補正（commit 前）

changelog を書き終えたら、**commit する前に必ず** 以下を実行して、追加・修正したエントリが [changelog.md](changelog.md) のルールに沿っているか確認し、違反があればその場で書き直してください。記載時に長くなりすぎたエントリを取りこぼさないための工程です。

1. このブランチで追加・修正した changelog エントリを抽出する:

   ```bash
   git diff main...HEAD -- <changelog ファイルパス> 2>/dev/null \
     || git diff origin/main...HEAD -- <changelog ファイルパス> 2>/dev/null \
     || git diff --cached -- <changelog ファイルパス>
   ```

   （まだ stage していない場合は `git diff -- <changelog ファイルパス>` でも可）

2. [changelog.md](changelog.md) と [change-title.md](change-title.md) を **改めて Read で読み込み**、抽出したエントリが以下を満たしているか照合する。**判定基準はルールファイルを唯一の正としてここでは複製しないこと**（このファイルにルールを直書きするとルールファイルと二元管理になり、ルール更新が反映されなくなるため）。

   - 特に [changelog.md](changelog.md) の「## 記載量」で定義された **1エントリにつき長くとも2行以内** に収まっているか
   - 分類・体言止め・原因→結果などタイトル本体のルール（[change-title.md](change-title.md)）

3. ルールに違反していると判定した場合は、エントリ本体を短縮して書き直し、**実装詳細・経緯・検証内容は PR 本文（description）へ移管**する。書き直し後はもう一度 1〜2 を実行して、ルールに収まっていることを確認してから commit に進む。

ルールに沿っていれば、修正不要としてそのまま次の commit / PR 作成へ進む。

## テスト（確認手順）

PRの概要（description）には、**ドメイン知識がないレビュワーやAIでも再現・検証できる**レベルの確認手順を記載してください。

### 基本方針

- 「何を確認するか」だけでなく「**どうやって確認するか**」を書く
- 手順は番号付きリストで、1ステップ1アクションにする
- 期待結果は各ステップまたはステップ群の直後に `→` で明示する
- 不具合修正の場合は **修正前の再現手順**（Before）と **修正後の確認手順**（After）を分けて書く

### 記載フォーマット

記載フォーマットの雛形は [pull-request-examples.md](pull-request-examples.md) を参照してください。

### 書くべき内容

書くべき内容（前提条件・操作対象の場所・具体的な操作・期待結果・デグレ確認）の一覧と例は [pull-request-examples.md](pull-request-examples.md) を参照してください。

### スクリーンショット

**表示・UI に関わる変更が含まれる場合は、Before / After のスクリーンショットを PR の概要に必ず添付してください。**

対象となる変更の例:
- フロント側の見た目（レイアウト・色・余白・フォントなど）の変更
- ブロックエディタや管理画面 UI の変更
- CSS / SCSS の変更
- レスポンシブ表示の変更

記載例は [pull-request-examples.md](pull-request-examples.md) を参照してください。

注意事項:

- 変更箇所が一目でわかるように、**同じ画面・同じ条件**で撮影した Before / After を並べる
- レスポンシブの変更を含む場合は、影響するブレークポイント（例: PC / タブレット / モバイル）ごとに添付する
- 純粋なロジック修正・内部処理の変更で表示に影響がない場合は省略可
- アニメーション・開閉・ホバーなど動きの確認が必要な変更は、静止画ではなく録画を GIF に変換して添付する
- 画像・GIF を `vektor-inc/review-assets` に保存して埋め込む場合は `?raw=true` 形式を使う（詳細は [testing/e2e.md](testing/e2e.md) の「画像・GIF の埋め込み URL 形式」を参照）
- 録画・GIF に確認に不要な機密情報（ログイン画面・顧客の個人情報・API キー／ライセンスキー等の設定画面・URL 内のトークン・別タブ）を含めない。画面そのものが確認対象となる場合はダミー／サンプルデータで撮影する（詳細は [testing/e2e.md](testing/e2e.md) の「録画・GIF に機密情報を含めない」を参照）

### 注意事項

- 「動作確認してください」「問題ないことを確認」のような抽象的な記載は不可。**具体的に何をどう操作し、何が起きれば正しいか**を書く
- ブロックエディタの操作は、ブロック名・サイドバーのパネル名・設定項目名を明記する
- レスポンシブの確認が必要な場合は、確認すべきブレークポイント（例: 576px以下）を明記する

## PR 作成後の対応（CodeRabbit 監視）

PR 作成後の CodeRabbit 監視・指摘トリアージは **呼び出し元のエージェント（通常は司）の責務** です。手順と責務の詳細は [coderabbit-monitoring.md](coderabbit-monitoring.md) を参照してください（責務の明文化は同ファイルを唯一の正とします）。**`features.coderabbit: false` の場合は CodeRabbit 監視・返信を行いません**（詳細は coderabbit-monitoring.md の「前提条件」参照）。なお CI（`run-ci` ラベル）はスキル・エージェントからは付与せず、手動・リリース時のみ実行します（同ファイル「CI について」参照）。

PR 作成者（実装担当のサブエージェント）の責務は **PR を作成し、PR URL を呼び出し元にハンドオフするまで** です。`START`（監視開始時刻）の取得は行いません。PR 作成 → CodeRabbit 即応答 → ハンドオフ の順序競合で投稿を取り逃すため、呼び出し元が PR の `createdAt` から取得します。
