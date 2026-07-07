# VK Orchestrator

GitHub issues をタスクキューとして使い、[VK Terminals](https://github.com/vektor-inc/vk-terminals) 上の Claude に自動実行させる**再利用可能なオーケストレーター**です。

これまで [task-queue](https://github.com/vektor-inc/task-queue) リポジトリに同居していたオーケストレーター部分を切り出したものです。task-queue は「実行する issue の管理（キューの実体）」に専念し、実行ロジックはこの VK Orchestrator が担います。

> 実装は task-queue/orchestrator から移設済みです（ユニットテスト 135 件パス）。設計・移行の背景は [`docs/MIGRATION-PLAN.md`](docs/MIGRATION-PLAN.md) を参照してください。移設に伴う汎用化として、取り込み対象ラベルを `QUEUE_LABEL` env で差し替え可能にしています。

## 役割分担

```
task-queue リポ (GitHub issues)  … 何を実行するか（キューの実体・ラベル運用）
        ▼
VK Orchestrator                  … いつ・どのペインに投げ、状態遷移を管理するか
        ▼  HTTP API (127.0.0.1:13847)
VK Terminals                     … 実際に Claude を動かす実行面
```

オーケストレーター経由のタスクに Claude エージェント（vk-kore の司 等）がどう振る舞うべきか（automerge での停止禁止・e2e 完了マーカーの付与責務・メタ issue クローズの責務など）は [`docs/agent-rules.md`](docs/agent-rules.md) を参照してください。

## 前提

このツールを動かすには次が必要です。

- **macOS**、または **Windows の WSL2（WSLg）上の Ubuntu**（VK Terminals が node-pty のネイティブビルドを伴う Electron アプリのため。GUI 表示に WSLg が必要）
- **Node.js 20 以上**
- **キュー用の GitHub リポジトリ**と、そこに設定されたステータスラベル群（`status:ready` ほか。`config.example.json` の owner/repo で指定）
- **GitHub Personal Access Token**（`repo` スコープ）
- 各ペインで動作する **Claude Code**

VK Terminals は `npm install` 時に依存として自動導入されます（`optionalDependencies`）。

> **WSL Ubuntu で動かす場合** — システム依存ライブラリの導入・GPU 設定・トラブルシューティングを含む、まっさらな環境からの手順を [`docs/WSL-UBUNTU-SETUP.md`](docs/WSL-UBUNTU-SETUP.md) にまとめています。

### 対応 PR の紐付け規約（必須）

orchestrator は「issue に対応する PR」を、**PR 本文に含まれる GitHub 標準のクローズキーワード＋issue 番号（`Closes #N` / `Fixes #N` / `Resolves #N` など）、または対象 issue の URL** で特定します。対応 PR を作成する際は **PR 本文に必ず `Closes #N` を記載してください**。記載のない PR は対応 PR として認識されず、完了判定（CodeRabbit / CI 監視）や automerge が進みません。ラベルやブランチ名規約による紐付けには対応していません（既定の vk-kore スキル経由で作成される PR はこの規約を満たします）。

## セットアップ

```bash
npm install                          # VK Terminals も一緒に導入される（optionalDependencies）
cp config.example.json config.json   # 下記の必須項目だけ埋めれば動きます
```

> **VK Terminals が「見つからない」と言われる場合** — `vk-terminals` は `optionalDependencies` かつ postinstall で node-pty / electron のネイティブビルドを行うため、ビルドに失敗すると **`npm install` は成功したまま vk-terminals だけ黙って除外**され、`up` 実行時に「VK Terminals が見つかりません」となります。次のコマンドで**ビルドログを表示しながら導入し直し、結果を検証**できます。
>
> ```bash
> npm run setup:terminals
> ```
>
> よくある失敗原因: **macOS で Xcode Command Line Tools 未導入**（→ `xcode-select --install`）、**macOS 以外**（GUI は macOS 専用。別マシンの VK Terminals API を使う構成なら `up` ではなく `start` を使い `vkTerminals.host` を対象マシンに向ける）、C/C++ ビルドツール不足やネットワークエラー。

**最低限、`github.token` / `github.owner` / `github.repo` の 3 つを自分の値に書き換えれば動きます。** その他の項目（`orchestrator.*` や `vkTerminals.*`）はすべて既定値が用意されているので、通常はそのままで構いません。とくに `vkTerminals.port`（既定 `13847`）と `vkTerminals.host`（既定 `127.0.0.1`）は**自分で値を決める必要はなく**、ポート衝突など特別な事情があるときだけ変更してください（設定を省略しても既定値で動作します）。

設定は**単一の `config.json` に集約**します（GitHub トークンも `github.token` に入れられます。`config.json` は `.gitignore` 対象）。`~/.vk-orchestrator/config.json` に置くとユーザー固有設定として優先的に読まれます（`VK_ORCHESTRATOR_CONFIG` で明示指定も可）。`.env` は必須ではありません（環境変数 > config.json > 既定値）。

### GitHub Personal Access Token の発行と設定

orchestrator は issue/PR の読み書き・ラベル操作・組織横断検索を行うため、GitHub の Personal Access Token（PAT）が必要です。**トークンは各自で発行し、自分のものを使ってください**（他人の `config.json` をトークンごとコピーして使い回さないこと）。

**発行手順（Classic PAT）**

1. GitHub 右上のアイコン → **Settings** → 左メニュー最下部 **Developer settings** → **Personal access tokens** → **Tokens (classic)** を開く（直接開くなら https://github.com/settings/tokens ）
2. **Generate new token → Generate new token (classic)** をクリック
3. **Note**（用途メモ。例: `vk-orchestrator`）と **Expiration**（有効期限）を設定
4. **Select scopes** で **`repo`（Full control of private repositories）** にチェック（issue/PR/ラベル操作に必要。private リポを扱うため `repo` 全体が必要）
5. **Generate token** を押し、表示された `ghp_...` を**その場でコピー**（画面を離れると二度と表示されません）
6. 対象組織が **SAML SSO** を有効にしている場合は、トークン一覧でそのトークンの **Configure SSO → Authorize** を実行して組織アクセスを許可する

> Fine-grained token を使う場合は、対象リポジトリに対して **Issues / Pull requests: Read and write**、**Contents: Read and write**、必要に応じて **Administration（ラベル作成用）** の権限を付与してください。まずは Classic PAT の `repo` スコープが簡単で確実です。

**トークンの設定方法（いずれか1つ）**

- **config.json に記載**（推奨）: `github.token` に `ghp_...` を入れる。`config.json` は `.gitignore` 対象なのでコミットされません。
- **環境変数**: `GITHUB_TOKEN=ghp_...`（env > config.json の優先順位なので、両方あれば env が優先）。
- **GUI 設定パネル**: `up` 起動後、GUI タイトルバーの ⚙ ボタン → Personal Access Token 欄に入力して保存。

**取り扱い上の注意**

- トークンは**パスワード相当の秘密情報**です。`config.json` ごと他人に渡さない、チャットやコミットに貼らない。
- 万一漏らした／共有してしまった場合は、GitHub のトークン一覧から**該当トークンを Revoke（失効）して再発行**してください。

`config.json` は手編集のほか、**`up` で起動した VK Terminals(GUI) のタイトルバー右端 ⚙ ボタンから GUI 上で編集・保存**できます（`up` が設定ディスクリプタを書き出し、環境変数 `VK_TERMINALS_SETTINGS` で GUI に渡します）。保存すると `config.json` がそのまま書き換わります。反映タイミングは orchestrator を再起動したとき（`vkTerminals` セクションの項目は次回 `up`/`apply` 時）です。

### ラベルの登録

運用に使うラベルは 2 系統あり、それぞれ一括登録コマンドを用意しています。`gh auth login` 済みの状態で実行してください。

**1. 取り込み対象ラベル（`task-queue`）を org 各リポへ** — orchestrator は org 横断の GitHub Search API で `task-queue` ラベルの付いた issue を探します。このラベルは依頼者が手で付けるため、各リポジトリに事前作成しておかないと候補に出ず取り込みが始まりません。新規リポジトリを対象に加えるときに流してください。

```bash
npm run setup:labels                     # org の全リポジトリに task-queue ラベルを ensure
node src/engine/ensure-task-queue-label.mjs repo1 repo2   # 指定リポジトリのみ
node src/engine/ensure-task-queue-label.mjs --list        # 対象リポジトリ一覧の表示だけ
```

**2. 運用ラベル一式（`status:*` / `priority:*` / `sequential` / `parallel` / `automerge`）をキューリポへ** — orchestrator が自動付与する `status:*` は未作成でも API 側で自動生成されますが、色がランダムになります。また `status:ready`（承認）・`priority:*`・`sequential`・`automerge` は**人間が手で付ける**ため、真っさらなキューリポでは事前登録しておかないと候補に出ません。キューリポのセットアップ時に流してください（色・説明は既定運用の定義に揃えて作成、既存はスキップ）。

```bash
npm run setup:queue-labels               # キューリポに status:* / priority:* など一式を ensure
node src/engine/ensure-task-queue-label.mjs --status --list   # 登録するラベル一覧の表示だけ
```

private リポジトリにアクセスするには `gh` の認証に加え、必要に応じて `SETUP_TOKEN=ghp_xxx`（`repo` スコープの classic PAT）を渡します。ラベル名・対象 org / キューリポは `config.json`（`github.queueLabel` / `owner` / `repo`）または環境変数（`QUEUE_LABEL` / `GITHUB_OWNER` / `GITHUB_REPO`）に従います（`queueLabel` を既定の `task-queue` から変えている場合、取り込み対象ラベルはそのラベル名で作成されます）。

## 起動

`up` 一発で、設定反映 → VK Terminals(GUI) 起動 → orchestrator 起動までまとめて行います。

```bash
npx vk-orchestrator up       # config.json を反映 → GUI 起動 → API 疎通を待って orchestrator を起動
# npm start でも同じ（start スクリプトは up に割り当て済み）
```

`up` は VK Terminals API の起動を待ってから、**GUI の中に orchestrator 専用ペイン（Claude を起動しない素のシェル）を開いて `vk-orchestrator start` を自動実行**します。ペイン上部には「オーケストレーター」というタイトルが立つので他ペインと一目で区別でき、GUI を閉じればペインごと orchestrator も終了します。これで **「ペインを開いて Claude を止めて `vk-orchestrator start` を打つ」手動手順は不要**です。

> VK Terminals API に疎通できない場合（`vkTerminals.host` が到達不能な Tailscale IP のとき等）は orchestrator ペインを作らず警告を出します。その場合は `host` 設定を見直すか、GUI 内のペインで手動起動してください。

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

`apply` を使えば VK Terminals を起動せず設定反映だけ行うこともできます。

```bash
npx vk-orchestrator apply
```

## VK Terminals との結合

VK Terminals は `optionalDependencies` として同梱（git 依存）しつつ、実行時の連携は HTTP API 契約だけで行います。その API クライアントは `src/terminals/` に閉じており、コードとしては import していません（＝疎結合のまま、導入と起動だけまとめている）。macOS 以外や native ビルド失敗時でも `npm install` 自体は成功し、`up` 実行時に未導入なら分かりやすくエラーを出します。

> **なぜ `@electron/rebuild` が optionalDependencies にあるか**: VK Terminals の `postinstall` は `electron-rebuild`（`@electron/rebuild` が提供）で node-pty を Electron 向けに再ビルドします。ところが `@electron/rebuild` は VK Terminals 側では **devDependencies** にあり、依存として導入する側（この VK Orchestrator）ではインストールされません。その結果 `electron-rebuild: command not found` で postinstall が失敗し、optional 依存の VK Terminals ごと破棄され「見つかりません」となります。これを避けるため VK Orchestrator 自身の依存に `@electron/rebuild` を持たせ、npm が nested postinstall 実行時に親の `node_modules/.bin` を PATH へ加える挙動を使って解決させています。

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
| `orchestrator.paneResumeMax` | `PANE_RESUME_MAX` | ペイン消失時（PR 未生成）の自動再開上限回数 | `3` |
| `orchestrator.assigneeFilter` | `ASSIGNEE_FILTER` | 担当者フィルタ | なし |
| `vkTerminals.port` / `vkTerminals.host` | `VK_TERMINALS_PORT` / `VK_TERMINALS_HOST` | VK Terminals API | `13847` / `127.0.0.1` |
| `vkTerminals.gpu` | `VK_TERMINALS_GPU` | GUI の GPU 起動モード（下記） | 空=自動 |
| `vkTerminals.initialCommand` / `agentroom` / `additionalPanes` | （`apply` で反映） | VK Terminals のペイン構成等 | — |

> **`vkTerminals.gpu`（GUI の GPU 起動モード）** — VK Terminals(GUI) は Electron アプリで、macOS 以外（WSLg 等の Linux）では Chromium の GPU 初期化が失敗し `up` 起動時に `Exiting GPU process` / `kTransientFailure` 等のエラーログが大量に出ます。値で挙動を選べます。
>
> - **空（既定・自動）** — macOS は通常起動、それ以外は `off` 相当。通常はこのままで OK。
> - **`off`** — GPU を無効化してエラーログを抑制（描画はソフトウェア。ターミナル用途で実害なし）。
> - **`default`** — フラグを足さず Chromium 任せ（元の挙動。macOS 以外では GPU 初期化エラーが出る場合あり）。
>
> 反映は次回 `up` 時。ターミナル用途では GPU アクセラの体感差はほぼ無いため、既定（`off` 相当）で十分です。
>
> ※ WSLg での HW アクセラ（HW OpenGL / Vulkan）は対応しません。Vulkan は HW ICD（dzn 等）が WSLg に無く、OpenGL も体感差が無いうえ Mesa/Dawn 由来の警告が出るためです。
