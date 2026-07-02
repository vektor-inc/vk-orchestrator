# VK Orchestrator 設計・移行プラン

task-queue / VK Terminals / vk-agents の 3 リポジトリ連携を、他の人でも使いやすい形に汎用化・統合するための第一弾。新規リポ **VK Orchestrator** を作り、task-queue のオーケストレーター部分をここへ移す。task-queue リポジトリは「実行する issue の管理（＝キューの実体）」だけを担うようにする。

---

## 1. 現状の構造（調査で確認した事実）

3 レイヤーがすでに疎結合で分かれている。

```
個別リポの issue に task-queue ラベル
        │  組織横断検索 (org:… label:task-queue)
        ▼
GitHub issues (vektor-inc/task-queue)  ← キューの実体（データ）
        │  status:ready の issue を取得
        ▼
orchestrator/ (index.js ほか)           ← オーケストレーション（コード）
        │  HTTP API /api/send 等
        ▼
VK Terminals (127.0.0.1:13847)          ← 実行面（Electron GUI + API）
        │  各ペインの Claude が実行
        ▼
PR 監視 → status 遷移 → merge → done
```

確認できた重要事実:

1. **VK Terminals への結合は `orchestrator/terminals.js` の 1 ファイルに完全に閉じている**。これを import しているのは `index.js` だけ。VK Terminals はソースを取り込む必要がなく、HTTP API 契約（`127.0.0.1:13847`）だけで成立する疎結合。
2. **VK Terminals 側にオーケストレーション用コードは一切ない**（issue/queue/github/poll いずれも grep でヒットせず）。VK Terminals は純粋に「実行面＋API」。
3. 実行時設定は**すでに環境変数化**済み（`GITHUB_OWNER` / `GITHUB_REPO` / `SOURCE_ORG` / `VK_TERMINALS_PORT` / `VK_TERMINALS_HOST` / `POLL_INTERVAL_MS` / `WATCHDOG_IDLE_MS` / `ASSIGNEE_FILTER`）。
4. **キューの実体は GitHub issues そのもの**。ラベルで状態管理している（`status:ready` / `in-progress` / `waiting-input` / `waiting-merge` / `done` / `failed`、および `sequential` / `automerge` / `priority:*`）。
5. **vk-agents は各ペインの中で動く Claude 側のルール／スキル定義**であり、オーケストレーションとは別レイヤー。この分割では基本そのまま。

---

## 2. 結合方式の決定：API 契約のみの疎結合（既定）

VK Terminals は純粋なライブラリではなく Electron GUI アプリなので「関数として import して使う」形にはならない。結合点は HTTP API のみで、それは `terminals.js`（API クライアント）に閉じている。したがって:

- **既定：方式 A（API 契約のみ）** — VK Orchestrator は VK Terminals のソースに依存しない。`terminals.js` を API クライアントとして内包し、起動中のアプリの API を叩く。最も疎結合で、他組織が「アプリを起動 → orchestrator を走らせる」だけで使える。
- **任意：方式 B（git 依存で同梱）** — 「1 リポ clone で完結させたい」場合のみ、`package.json` に `"vk-terminals": "github:vektor-inc/vk-terminals"` を宣言し、launcher で Electron アプリを起動する。A と併用可（同梱しても通信は API 経由）。

> 「composer ライブラリのように import」という当初のイメージは、実体としては **API クライアント（`terminals.js`）への依存**に相当する。VK Terminals 本体のコードは取り込まない。

---

## 3. ファイル振り分け

現 `task-queue/orchestrator/` の内訳と行き先。

| ファイル | 役割 | 行き先 |
|---|---|---|
| `index.js` (1369 行) | メインループ／進行判断エンジン | **vk-orchestrator** `src/engine/` |
| `terminals.js` (495) | VK Terminals API クライアント（結合点） | **vk-orchestrator** `src/terminals/` |
| `github.js` (936) | issue 読み書き・PR 監視クライアント | **vk-orchestrator** `src/github/` |
| `state.js` (86) | ローカル状態の永続化 | **vk-orchestrator** `src/engine/` |
| `cleanup.js` (294) | worktree 後片付け | **vk-orchestrator** `src/engine/` |
| `done-gate.js` (63) | done 遷移ゲート | **vk-orchestrator** `src/engine/` |
| `in-progress-decision.js` (76) | in-progress 時の行動判断 | **vk-orchestrator** `src/engine/` |
| `decision-record.js` (261) | 待機入力後の返信判定 | **vk-orchestrator** `src/engine/` |
| `redact-secrets.js` (60) | ログのシークレット除去 | **vk-orchestrator** `src/engine/` |
| `check-status.mjs` / `unblock.mjs` | 運用者向け CLI | **vk-orchestrator** `bin/` |
| `ensure-task-queue-label.mjs` (132) | ラベル作成 | 両用（後述） |
| `.github/labels.yml` / issue テンプレ | キューの定義 | **task-queue に残す** |
| `README.md`（キューの使い方部分） | 運用ドキュメント | 分割（後述） |

要するに、**実行時コードはほぼ全部 VK Orchestrator へ移り、task-queue リポは「ラベル定義＋issue テンプレ＋issue を溜める場所」というデータ／設定リポになる**。

---

## 4. VK Orchestrator ディレクトリ構成（雛形）

```
vk-orchestrator/
├── package.json          # bin: vk-orchestrator, 依存: @octokit/rest, dotenv
├── .env.example          # 汎用化した設定テンプレ
├── README.md
├── bin/
│   └── vk-orchestrator.js # CLI エントリ（start / run-once / check-status / unblock）
├── src/
│   ├── config.js         # env 読み込みを一元化（ハードコード排除）
│   ├── engine/           # index.js を分割移設したメインループ + 判断ロジック
│   ├── github/           # github.js（issue/PR クライアント）
│   └── terminals/        # terminals.js（VK Terminals API クライアント）
└── docs/
    └── MIGRATION-PLAN.md
```

---

## 5. 汎用化のための変更点

1. **ラベル名のハードコード排除**：`github.js` にリテラル `'task-queue'`（ラベル作成・取り込みコメント文言。おおよそ 892・912 行付近）がある。`QUEUE_LABEL`（既定 `task-queue`）env に外出しし、他組織が自前のキュー名で使えるようにする。
2. **設定の一元化**：現状 3 リポに散った設定を VK Orchestrator の `.env` + `src/config.js` に集約。他組織は clone せず env を自分のリポに向けるだけで動く。
3. **キューリポの外部化**：`GITHUB_OWNER` / `GITHUB_REPO` / `SOURCE_ORG` は既存の env で対応済み。task-queue リポ名も設定値として扱う。
4. **CLI 化**：`npm start` 前提から `npx vk-orchestrator start` 等の CLI エントリに寄せ、インストールして使える形にする。

---

## 6. 移行手順（段階的・後方互換を保つ）

1. **雛形作成**（本コミット）：空の VK Orchestrator 構成 + プラン文書。
2. **コード移設**：`orchestrator/*.js` を `src/` へコピーし、相対 import を新構成に合わせて修正。ロジックは変えない。
3. **config 一元化**：`src/config.js` を追加し、各モジュールの `process.env` 直読みを集約。ラベル名を env 化。
4. **結合方式の確定**：まず方式 A（API クライアント内包）で動作確認。必要なら方式 B（git 依存 + launcher）を追加。
5. **テスト移設**：`task-queue/tests/` のうちオーケストレーター系を VK Orchestrator へ移す。
6. **task-queue の整理**：orchestrator/ を削除し、README を「キューの使い方（ラベル運用・issue 取り込みフロー）」だけに縮小。`.github/labels.yml` とテンプレは残す。
7. **切替期間**：task-queue 側 README に「オーケストレーターは VK Orchestrator に移動」と明記し、旧手順から誘導。

---

## 7. できる／できないの結論

**できる。しかも今の設計はかなり分離しやすい状態にある。** VK Terminals 結合が 1 ファイルに閉じ、設定が env 化済みで、キューが GitHub issues という外部データであるため、コードの大半をそのまま VK Orchestrator へ移し、task-queue を「issue 管理だけ」に縮小する構想は素直に成立する。汎用化で追加で必要なのは、ラベル名のハードコード排除と設定の一元化という比較的小さな作業に留まる。
