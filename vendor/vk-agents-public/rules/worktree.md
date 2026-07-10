> **注意:** このファイルは https://github.com/vektor-inc/vk-agents で管理されています。内容を変更する場合は、このファイルを直接編集せず、元リポジトリの方で変更してください。

# Agent worktree のルール

`Agent` ツールの `isolation: "worktree"` で実装作業を行う際のルールと既知の罠。

## いつ worktree を使うか

- 実装を伴う長時間タスク（/vk-kore など）でサブエージェントを起動する場合は、`isolation: "worktree"` を指定すること。メインのワーキングツリーを直接変更すると、ユーザーや他エージェントの並行作業と競合するため
- 読み取りだけのタスク（調査・レビュー）には不要

## 罠1: worktree はデフォルトブランチから切られる

`isolation: "worktree"` の worktree は **リポジトリのデフォルトブランチ（多くの場合 main）から切られる**。現在 checkout している feature ブランチからは切られない。

- feature ブランチで進めた最新コミットは worktree から **見えない**。エージェントは古い main の内容を読んで作業してしまう
- 作業させたいファイルが feature ブランチにしか無い場合は、worktree を使わず通常起動にするか、先にデフォルトブランチへマージ／push してから起動する
- エージェント完了後の diff 確認は、feature ブランチとではなく **デフォルトブランチと比較** する（ブランチ間 diff だと feature 側の変更が「相手に無い」状態で表示されて惑わされる）

## 罠2: wp-env のマウント名が worktree ディレクトリ名になる

worktree 内で wp-env を起動すると、コンテナ内のプラグインフォルダが **worktree ディレクトリ名（例: `agent-ac1fb506bfdbf8271`）** でマウントされる。

- `package.json` の scripts が `--env-cwd='wp-content/plugins/<本来のプラグイン名>'` をハードコードしている場合、パス不一致で chdir エラーになり `npm run phpunit` 等が落ちる
- worktree でテスト系コマンドを実行するエージェントには、`--env-cwd='wp-content/plugins/<worktreeディレクトリ名>'` を明示するよう事前に伝えること
- e2e の tests サイトは `testsPort`（wp-env ポート + 1）なので、必要に応じて `WP_BASE_URL=http://localhost:<testsPort>` も明示する

## 罠3: package-lock.json の name が worktree ディレクトリ名になる

`package.json` に `name` フィールドが無いリポジトリで worktree 内 `npm install` を実行すると、`package-lock.json` の `"name"` が worktree ディレクトリ名（`agent-xxxx`）で焼き付き、main の lock と不整合になる。

- worktree ベースの PR で npm 依存を追加・更新する場合は、先に `package.json` へ `"name": "<正しいパッケージ名>"` と `"private": true` を追加してから lock を生成すること

## Team エージェントの name は英数字にする

複数のペルソナを同一 team に入れる場合、`Agent` 起動時の `name` パラメータは **必ず英数字**（例: `tsukasa` / `wada` / `ando` / `remi` / `uekusa`）で指定すること。

- 日本語名で起動すると inbox ファイル名の生成で日本語が保持されず、複数メンバーの inbox が衝突して `SendMessage` が **誤配送** される（タスク実行自体は動くため気づきにくい）
- ペルソナ内部の自己紹介・口調・一人称は従来どおり日本語名（司・和田など）でよい
- 衝突の有無は `~/.claude/teams/{team}/inboxes/` のファイル数（メンバー数 + `team-lead.json`）で確認できる
