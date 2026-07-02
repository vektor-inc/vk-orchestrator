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

## セットアップ

設定は**単一の `config.json` に集約**し、秘密情報（GitHub トークン）だけ `.env` に置きます。

```bash
npm install
cp config.example.json config.json   # owner / repo / vk-terminals 設定などを編集
cp .env.example .env                  # GITHUB_TOKEN を記入
```

優先順位は「環境変数(.env) > config.json > 既定値」です。`config.json` は `~/.vk-orchestrator/config.json` に置くとユーザー固有設定として優先的に読まれます（`VK_ORCHESTRATOR_CONFIG` で明示指定も可）。

vk-terminals 側の設定（ペイン構成・initialCommand・agentroom）も同じ `config.json` の `vkTerminals` セクションにまとめ、次のコマンドで vk-terminals が読む `~/.vk-terminals/config.json` に反映できます。

```bash
npx vk-orchestrator apply    # config.json の vkTerminals 設定を ~/.vk-terminals/config.json へ書き出し
```

vk-terminals を起動しておき（API が待ち受ける状態）、別途:

```bash
npx vk-orchestrator start          # キューを監視して実行
npx vk-orchestrator start --once   # 1 周だけ実行
npx vk-orchestrator check-status   # 現在の状態を表示
```

## vk-terminals との結合

vk-terminals のソースは取り込みません。結合は HTTP API 契約だけで、その API クライアントは `src/terminals/` に閉じています（疎結合）。他組織は vk-terminals アプリを起動し、`.env` を自分のキューリポに向けるだけで使えます。

## 設定項目

`.env`（秘密）:

| キー | 意味 | 既定 |
|---|---|---|
| `GITHUB_TOKEN` | PAT（repo スコープ） | （必須） |

`config.json`（config.example.json 参照。env で個別上書き可）:

| セクション.キー | 対応 env | 意味 | 既定 |
|---|---|---|---|
| `github.owner` / `github.repo` | `GITHUB_OWNER` / `GITHUB_REPO` | キューリポ | `your-org` / `task-queue` |
| `github.sourceOrg` | `SOURCE_ORG` | 取り込み対象 org | owner と同じ |
| `github.queueLabel` | `QUEUE_LABEL` | 取り込み対象ラベル名 | `task-queue` |
| `orchestrator.pollIntervalMs` | `POLL_INTERVAL_MS` | ポーリング間隔 | `60000` |
| `orchestrator.watchdogIdleMs` | `WATCHDOG_IDLE_MS` | ウォッチドッグ閾値 | `10800000` |
| `orchestrator.assigneeFilter` | `ASSIGNEE_FILTER` | 担当者フィルタ | なし |
| `vkTerminals.port` / `vkTerminals.host` | `VK_TERMINALS_PORT` / `VK_TERMINALS_HOST` | vk-terminals API | `13847` / `127.0.0.1` |
| `vkTerminals.initialCommand` / `agentroom` / `additionalPanes` | （`apply` で反映） | vk-terminals のペイン構成等 | — |
