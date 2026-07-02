# vk-orchestrator

GitHub issues をタスクキューとして使い、[vk-terminals](https://github.com/vektor-inc/vk-terminals) 上の Claude に自動実行させる**再利用可能なオーケストレーター**です。

これまで [task-queue](https://github.com/vektor-inc/task-queue) リポジトリに同居していたオーケストレーター部分を切り出したものです。task-queue は「実行する issue の管理（キューの実体）」に専念し、実行ロジックはこの vk-orchestrator が担います。

> 実装は task-queue/orchestrator から移設済みです（ユニットテスト 135 件パス）。設計・移行の背景は [`docs/MIGRATION-PLAN.md`](docs/MIGRATION-PLAN.md) を参照してください。移設に伴う汎用化として、取り込み対象ラベルを `QUEUE_LABEL` env で差し替え可能にしています。

## 役割分担

```
task-queue リポ (GitHub issues)  … 何を実行するか（キューの実体・ラベル運用）
        ▼
vk-orchestrator                  … いつ・どのペインに投げ、状態遷移を管理するか
        ▼  HTTP API (127.0.0.1:13847)
vk-terminals                     … 実際に Claude を動かす実行面
```

## 前提

このツールを動かすには次が必要です。

- **macOS**（vk-terminals が node-pty のネイティブビルドを伴う Electron アプリのため）
- **Node.js 20 以上**
- **キュー用の GitHub リポジトリ**と、そこに設定されたステータスラベル群（`status:ready` ほか。`config.example.json` の owner/repo で指定）
- **GitHub Personal Access Token**（`repo` スコープ）
- 各ペインで動作する **Claude Code**

vk-terminals は `npm install` 時に依存として自動導入されます（`optionalDependencies`）。

## セットアップ

```bash
npm install                          # vk-terminals も一緒に導入される
cp config.example.json config.json   # token / owner / repo / vk-terminals 設定などを編集
```

設定は**単一の `config.json` に集約**します（GitHub トークンも `github.token` に入れられます。`config.json` は `.gitignore` 対象）。`~/.vk-orchestrator/config.json` に置くとユーザー固有設定として優先的に読まれます（`VK_ORCHESTRATOR_CONFIG` で明示指定も可）。`.env` は必須ではありません（環境変数 > config.json > 既定値）。

## 起動

`up` 一発で、設定反映 → vk-terminals(GUI) 起動 → orchestrator 起動までまとめて行います。

```bash
npx vk-orchestrator up       # config.json を反映 → GUI 起動 → API 疎通を待って orchestrator を起動
# npm start でも同じ（start スクリプトは up に割り当て済み）
```

`up` は vk-terminals API の起動を待ってから、**GUI の中に orchestrator 専用ペイン（Claude を起動しない素のシェル）を開いて `vk-orchestrator start` を自動実行**します。ペイン上部には「オーケストレーター」というタイトルが立つので他ペインと一目で区別でき、GUI を閉じればペインごと orchestrator も終了します。これで **「ペインを開いて Claude を止めて `vk-orchestrator start` を打つ」手動手順は不要**です。

> vk-terminals API に疎通できない場合（`vkTerminals.host` が到達不能な Tailscale IP のとき等）は orchestrator ペインを作らず警告を出します。その場合は `host` 設定を見直すか、GUI 内のペインで手動起動してください。

GUI だけ起動したい（orchestrator は別途手動で回す）場合は `--no-orchestrator` を付けます。

```bash
npx vk-orchestrator up --no-orchestrator   # GUI のみ起動
```

orchestrator を単体で動かしたい場合（別マシンから API を叩く・1 周だけ回す等）は `start` を直接使います。

```bash
npx vk-orchestrator start          # キューを監視して実行
npx vk-orchestrator start --once   # 1 周だけ実行
npx vk-orchestrator check-status   # 現在の状態を表示
```

`apply` を使えば vk-terminals を起動せず設定反映だけ行うこともできます。

```bash
npx vk-orchestrator apply
```

## vk-terminals との結合

vk-terminals は `optionalDependencies` として同梱（git 依存）しつつ、実行時の連携は HTTP API 契約だけで行います。その API クライアントは `src/terminals/` に閉じており、コードとしては import していません（＝疎結合のまま、導入と起動だけまとめている）。macOS 以外や native ビルド失敗時でも `npm install` 自体は成功し、`up` 実行時に未導入なら分かりやすくエラーを出します。

> **なぜ `@electron/rebuild` が optionalDependencies にあるか**: vk-terminals の `postinstall` は `electron-rebuild`（`@electron/rebuild` が提供）で node-pty を Electron 向けに再ビルドします。ところが `@electron/rebuild` は vk-terminals 側では **devDependencies** にあり、依存として導入する側（この vk-orchestrator）ではインストールされません。その結果 `electron-rebuild: command not found` で postinstall が失敗し、optional 依存の vk-terminals ごと破棄され「見つかりません」となります。これを避けるため vk-orchestrator 自身の依存に `@electron/rebuild` を持たせ、npm が nested postinstall 実行時に親の `node_modules/.bin` を PATH へ加える挙動を使って解決させています。

## 設定項目

`config.json`（config.example.json 参照。同名の環境変数があればそちらが優先）:

| セクション.キー | 対応 env | 意味 | 既定 |
|---|---|---|---|
| `github.token` | `GITHUB_TOKEN` | PAT（repo スコープ） | （必須） |
| `github.owner` / `github.repo` | `GITHUB_OWNER` / `GITHUB_REPO` | キューリポ | `your-org` / `task-queue` |
| `github.sourceOrg` | `SOURCE_ORG` | 取り込み対象 org | owner と同じ |
| `github.queueLabel` | `QUEUE_LABEL` | 取り込み対象ラベル名 | `task-queue` |
| `orchestrator.pollIntervalMs` | `POLL_INTERVAL_MS` | ポーリング間隔 | `60000` |
| `orchestrator.watchdogIdleMs` | `WATCHDOG_IDLE_MS` | ウォッチドッグ閾値 | `10800000` |
| `orchestrator.assigneeFilter` | `ASSIGNEE_FILTER` | 担当者フィルタ | なし |
| `vkTerminals.port` / `vkTerminals.host` | `VK_TERMINALS_PORT` / `VK_TERMINALS_HOST` | vk-terminals API | `13847` / `127.0.0.1` |
| `vkTerminals.initialCommand` / `agentroom` / `additionalPanes` | （`apply` で反映） | vk-terminals のペイン構成等 | — |
