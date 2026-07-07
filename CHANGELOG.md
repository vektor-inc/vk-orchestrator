# Changelog

- [ 機能追加 ] automerge の e2e 完了ゲートを config でオプション化（`task.requireE2eGate`、既定 true）。false にすると e2e を回さないプロジェクトでもマーカー無しで automerge が進む（CI/CodeRabbit ゲートは維持）
- [ 仕様変更 ] 作業対象リポ側の issue に付ける作業中ラベルの既定名を「作業中」から「working」に変更し、GUI 設定項目から撤去（config.json の `labels.workingInProgress` 直書きでのみ上書き可）
- [ その他 ] 未使用だった `labels.e2ePassed` / `e2ePassedShaPrefix` の config・GUI 枠を撤去（マーカー名は `src/github/index.js` の固定定数に集約）

= 0.1.0 =
- [ 機能追加 ] タスク着手コマンドを config テンプレート化（`task.commandTemplate` / `portBase` / `portStride`）。`task.wpEnv.enabled: false` で wp-env 連携（ポート割り当て・state 保存・クリーンアップ）を無効化し、vk-kore 以外のスキルや素のプロンプトも起動可能に（既定は現行と同一挙動）
- [ 機能追加 ] 汎用化に向け config.json に task / protocol / labels セクションと既定値・getter・GUI 設定枠を追加（既定値は現行のハードコード値のため単体では挙動不変）
- [ 機能追加 ] 設定パネルの各項目に説明文（help）を追加し、Repo・Queue Label・ウォッチドッグ idle などの意味と入力例を GUI 上で確認できるように
- [ 機能追加 ] `up` 起動時に VK Terminals(GUI) のタイトルバー ⚙ ボタンから統合 `config.json` を編集・保存できる設定パネルを追加。`up` が設定ディスクリプタ（編集対象パス + 項目スキーマ）を書き出し、環境変数 `VK_TERMINALS_SETTINGS` で GUI に渡す。これにより GitHub トークン等を手編集せず GUI 上で設定できる（保存後、orchestrator の再起動で反映）
- [ 機能追加 ] `up`（`npm start`）起動時に vk-terminals のリモート最新タグを自動取得し、node_modules が古ければ入れ直してから GUI を起動するように（vk-terminals 側でタグを打つだけで各環境が最新に追従し、orchestrator の bump/push/pull が不要に。`VK_TERMINALS_TAG` で版固定、`VK_TERMINALS_NO_AUTO_UPDATE=1` で自動追従の無効化も可能）
- [ 機能追加 ] VK Terminals を明示的に導入・検証する `setup-terminals` サブコマンド（`npm run setup:terminals`）を追加。optionalDependencies のビルド失敗で黙って除外されるケースを検知し、ビルドログと原因（Xcode CLT 未導入・非 macOS 等）を表示。`up`／`apply` 時の未導入メッセージも原因と復旧手順を示すよう改善
- [ 機能追加 ] キューリポに運用ラベル一式（`status:*` / `priority:*` / `sequential` / `parallel` / `automerge`）を色・説明つきで一括登録する `--status` モードを `ensure-task-queue-label.mjs` に追加し、`npm run setup:queue-labels` として実行できるよう package.json に登録
- [ 仕様変更 ] assignee 設定時、source issue の取り込みを「自分にアサインされた issue のみ」に限定し、取り込んだ task-queue issue にも取り込んだユーザーを自動アサイン（誰が取り込み・処理するかを明確化。未設定時は従来どおり全件取り込み）
- [ 仕様変更 ] vk-terminals 依存をタグ `1.5.2` に固定し、取得を SSH から https に変更（ブランチ HEAD 追従をやめ、SSH 鍵なしの環境でも導入できるように）
- [ 仕様変更 ] decision-record コメントの判定を識別行マーカー（`Comment by vk-agents`）非依存にし、単独行の `Status:` トークンのみで判断するように（コメント1行目が任意でも動作。`protocol.agentMarker` 設定は撤去）
- [ 仕様変更 ] ドキュメント・UI 表示・ログ・コメントの製品名表記を VK Orchestrator / VK Terminals に統一（コマンド・パス・パッケージ名などのコード上の識別子は従来どおり小文字）
- [ 不具合修正 ] コールドスタート時に Claude Code の起動バナーがプロンプト本文を飲み込み、`/vk-kore` 等の指示が入力欄に届かないまま処理が進んでしまう不具合を修正
- [ 不具合修正 ] org リポの一括ラベル登録が1ページ目（100件）しか処理せず、100件を超えるリポにラベルが登録されない不具合を修正
- [ 開発環境 ] vk-terminals 依存の更新（タグ解決 → package.json / package-lock.json / CHANGELOG 書き換え → 検証）をまとめて行う `npm run bump:terminals <version>` を追加
- [ その他 ] README のセットアップ手順に、初回設定で必須なのは `github.token` / `owner` / `repo` の 3 項目のみで、`vkTerminals.port` / `host` は既定値のままでよい旨を明記
- [ その他 ] 取り込み対象ラベルの一括登録手順を README に追記し、`npm run setup:labels`（`ensure-task-queue-label.mjs`）として実行できるよう package.json に登録。ラベル名は config.json / `QUEUE_LABEL` に追従（既定 `task-queue`）
- [ その他 ] README に GitHub Personal Access Token の発行手順（Classic PAT / `repo` スコープ / SAML SSO 認可）・設定方法（config.json / 環境変数 / GUI）・取り扱い注意を追記
