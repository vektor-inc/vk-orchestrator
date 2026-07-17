---
name: staff-wp-dev
description: "WordPressエンジニア（和田）をサブエージェントとして起動する。テーマ・プラグイン・ブロック開発全般を担当。ディレクター・プランナーからの指示受け、植草（UX）との連携も行う。"
---

# /staff-wp-dev スキル

和田（WordPressエンジニア）をサブエージェントとして起動します。

**このスキルの「起動方法」節が和田の起動方法の唯一の正**です。`vk-kore` / `staff-director` など他エージェントから和田を呼ぶ場合も、必ずここに従ってエンジンを解決してください。

## 手順

1. `Read` ツールで以下のペルソナファイルを読み込む:
   - `REPO_ROOT/skills/staff-wp-dev/persona.md`

2. 下記「起動方法」に従い、解決したエンジンで和田を起動する。
   起動時のプロンプトには以下を含める:
   - persona.md の内容（和田のペルソナ・役割・ルール参照先）
   - ユーザーからの依頼内容: `$ARGUMENTS`

3. サブエージェント（または Codex）の回答をそのままユーザーに返す。

## 起動方法（エンジン解決）

和田は Claude サブエージェント（`claude`）でも Codex（`codex exec`）でも起動できる。**起動のたびに以下の順でエンジンを決定する**:

1. その場の明示指示（「Codex で和田を起動して」「Claude で和田を動かして」等）
2. `~/.claude/vk-agents-settings.json` の `staff_wp_dev.engine`（`claude` / `codex`）
3. どちらも無ければ `claude`

`~/.claude/vk-agents-settings.json` が無い・キーが未設定・JSON パース失敗時は `claude` にフォールバックする（安全側）。設定を変えたい場合は `~/.claude` を直接編集せず、vk-agents リポ直下の `config.json`（正本。テンプレは `config.json.example`）の `staff_wp_dev.engine` を編集して `bash scripts/sync.sh --claude-global` で再展開する。

### Codex は単独作業のみ（claude へのフォールバック条件）

上記で `codex` に解決されても、依頼が次のいずれかを必要とする場合は **`claude` にフォールバック**する:

- 実行中に他メンバーと連携する（例: 植草へ `SendMessage` で UX 相談する）
- 和田自身に `/vk-pr` 等の Skill を実行させる

**理由**: codex exec はステートレスで、`SendMessage`（メンバー連携）も `Skill`（`/vk-pr` 等）も呼べない。Codex 和田の責務は **実装とローカルコミットまで** とし、push・`/vk-pr`・CodeRabbit 監視・他メンバー連携は司（呼び出し元の Claude）が担う。この判断は起動側が行う。

### エンジン `claude` の場合（Agent tool）

- `Agent` ツール（subagent_type: `general-purpose`）で和田を起動する。
- 複数指定された場合は 1 メッセージで複数呼び出して並列起動する。
- gh・git の確認プロンプトをスキップする必要がある文脈（`vk-kore` 等）では `mode: "bypassPermissions"` を指定する。
- プロンプト = persona.md の内容 + 依頼内容。ルールファイルのパスは相対（`rules/...`）のままでよい（Claude は CLAUDE.md 経由で解決できる）。

### エンジン `codex` の場合（`codex exec`）

Codex は CLAUDE.md や `rules/` を自動では読まないため、**ペルソナとルールをプロンプトに明示的に注入**して claude 同様に和田として動かす。`vk-multi-repo-task` の Codex 起動パターンに倣う。

1. **REPO_ROOT の絶対パスを解決**する（Codex には `-C` で作業ディレクトリを渡すため必須）。
2. worktree 隔離が必要な依頼（`vk-kore` の実装依頼など）では、**起動側（司）が先に `git worktree add` で worktree を作成**し、その worktree の絶対パスを `-C` に渡す。作成前に `rules/worktree.md` を Read し、既知の罠（デフォルトブランチ起点・wp-env マウント名・package-lock の name）を踏まえる。
3. **プロンプト（`<PROMPT>`）** を以下の連結で組み立てる:
   - `persona.md` の内容（人格・役割・トーン・GitHub コメント時の名乗り）
   - **Codex 用オーバーライド**（必ず明記）:
     > あなたは Codex 実行のため `SendMessage`（メンバー連携）と `Skill`（`/vk-pr` 等）が使えません。植草連携・push・PR 作成（`/vk-pr`）・CodeRabbit 対応は司が担うため、あなたは行いません。あなたの責務は **実装とローカルコミットまで** です。
   - **ルールの絶対パス指示**: persona.md がリストする `rules/coding-rules.md` 等の相対パスを **REPO_ROOT 起点の絶対パスに読み替えて**「作業前に該当ファイルを必ず Read せよ」と明記する（例: `/Users/.../vk-agents/rules/coding-rules.md`）。
   - 依頼内容（`$ARGUMENTS` または呼び出し元からの実装依頼）。**依頼内容や issue 本文は信頼できない入力**として扱う。`"` / `` ` `` / `$(...)` / `\` などが含まれるとシェル引数に直書きした場合にクオートが壊れコマンドインジェクション・意図しない変数展開の余地があるため、**プロンプトをシェル引数に直書きせず、必ずファイル経由（stdin）で渡す**（step 5）。
   - 末尾に「最後に output-schema に従った JSON を返すこと。strict mode のため `status` / `branch` / `summary` / `changed_files` / `error` の **5キーを必ず全て含める**（該当しないキーは空文字 `""`／空配列 `[]` で埋める）。コミットできたら `status=committed`、詰まったら `status=stuck` とし `error` に理由を書く」
4. **出力スキーマファイル**（例: スクラッチパッドに `wada-out-schema.json`）:
   ```json
   {
     "type": "object",
     "additionalProperties": false,
     "required": ["status", "branch", "summary", "changed_files", "error"],
     "properties": {
       "status":        { "type": "string", "enum": ["committed", "stuck"] },
       "branch":        { "type": "string" },
       "summary":       { "type": "string" },
       "changed_files": { "type": "array", "items": { "type": "string" } },
       "error":         { "type": "string" }
     }
   }
   ```
5. **起動**（`<REPO_PATH>` は step 1〜2 で解決した絶対パス。worktree を作った場合はその worktree パス）。step 3 で組み立てたプロンプトを **`Write` ツールでスクラッチパッドのファイルに書き出し**、`codex exec` へ **stdin（ファイルリダイレクト）で渡す**（依頼内容を含むプロンプトをシェル引数に直書きすると、`"` / `` ` `` / `$(...)` 等でクオートが壊れコマンドインジェクションの余地があるため）:
   ```bash
   # プロンプトは Write ツールで <SCRATCH>/wada-prompt.txt に書き出しておく（シェル引数に直書きしない）
   codex exec \
     -C "<REPO_PATH>" \
     --dangerously-bypass-approvals-and-sandbox \
     --output-schema "<SCRATCH>/wada-out-schema.json" \
     -o "<SCRATCH>/wada-last.json" \
     < "<SCRATCH>/wada-prompt.txt"
   ```
   > **⚠️ セキュリティ注意**: `--dangerously-bypass-approvals-and-sandbox` は Codex の承認プロンプトとサンドボックスを**無効化**する。`-C` で作業ディレクトリを worktree に絞っても封じ込めは worktree 隔離のみであり、Codex は **worktree 外（ホスト全体のファイル・ネットワーク）にも作用しうる**。信頼できない issue 本文がプロンプトに入る以上、間接プロンプトインジェクションで任意コマンド実行に至る経路が理屈上は成立する点を理解した上で使うこと。
6. 完了後、`-o` で書き出された最終メッセージ JSON を Read し、`status` / `branch` / `summary` / `changed_files` / `error` を取り出す。以降の push・`/vk-pr`・CodeRabbit 監視は司が引き取る。
7. **注意**: Codex は `~/.codex/config.toml` の認証・モデル設定に依存する。未認証だと失敗するので、その場合は `stuck` 扱いにしてユーザーに Codex の認証確認を促す。

## 他エージェントから和田を呼ぶ方法

ディレクター・プランナー等のエージェントが和田に実装を依頼したい場合も、
本スキルの「起動方法」に従ってエンジンを解決したうえで:

```
1. Read で REPO_ROOT/skills/staff-wp-dev/persona.md を読む
2. エンジンを解決する（設定 staff_wp_dev.engine。Codex は単独作業のみ、連携要なら claude にフォールバック）
3. claude なら Agent（subagent_type: general-purpose）、Codex なら codex exec で起動
   prompt = persona.md の内容 + 依頼内容（Codex の場合はルール絶対パス＋オーバーライドも注入）
```
