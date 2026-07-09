# Changelog

- [ 不具合修正 ] wp-env 無効時に vk-kore 起動コマンドへ未展開の `wp-env-port={wpPort}` が残って送出される不具合の修正
- [ 不具合修正 ] ペインへの本文再送時に入力行をクリアせず起動コマンドが重複連結される不具合の修正
- [ 不具合修正 ] 入力待ちマーカーが set-title 相乗り経路で VK Terminals に届かず「入力待ち」ラベルが点灯しない不具合を修正（正規の /api/set-status 経路へ変更）

= 0.9.0 =
- [ 機能追加 ] status:waiting-input の issue 連動ペインに入力待ちマーカーを push し、定期監視で再点灯／in-progress 復帰時に消灯する機能を追加
- [ 仕様変更 ] automerge 完了ゲートを `agent-review-passed` マーカー規約に一本化し、`requireE2eGate` 設定を廃止
- [ 仕様変更 ] vk-terminals を 1.12.0 から 1.13.0 にアップデート
- [ 不具合修正 ] 設定パネルの「automerge の e2e ゲートを必須化」チェックボックスが、保存値なしの初期状態で実際の既定（ON）と異なり未チェック表示になる不具合を修正

= 0.8.0 =
- [ 機能追加 ] up で起動する orchestrator ペインを、VK Terminals のサイドバーに格納した折りたたみ状態で開くように
- [ 仕様変更 ] vk-terminals を 1.11.1 から 1.12.0 にアップデート

= 0.7.0 =
- [ 機能追加 ] wp-env ポート割り当てに空きポート自動探索を追加し、決定論的な起点から占有中・8888/8889・他タスク使用中のポートを避けて割り当て
- [ 機能追加 ] GUI 設定パネルから vk-agents の CodeRabbit 監視・和田/マルチリポタスクの実行エンジンを設定できる機能を追加
- [ 仕様変更 ] 作業対象リポジトリの issue に投稿する取り込み・完了・失敗の通知コメント文言を「task-queue」から「オーケストレーター」表記に変更
- [ 仕様変更 ] vk-terminals を 1.10.1 から 1.11.1 にアップデート

= 0.6.0 =
- [ 仕様変更 ] wp-env 連携の ON/OFF を、対象リポジトリの `.wp-env.json` 有無から着手時に自動判定するようにし、GUI の手動トグル（wp-env 連携を有効化）を撤去（`task.wpEnv.enabled` の config.json / 環境変数での明示指定は自動判定より優先する脱出ハッチとして存続）
- [ 仕様変更 ] 設定 UI から「エージェントルーム表示」トグルを撤去（config.json の `vkTerminals.agentroom` 直書きでのみ上書き可）
- [ 仕様変更 ] vk-terminals を 1.9.1 から 1.10.1 にアップデート
- [ 仕様変更 ] 設定項目 owner/repo/sourceOrg のラベル・ヘルプを「タスク登録リポジトリ」「作業対象リポジトリ」に統一し、曖昧だった「監視対象」表記を解消
- [ 開発環境 ] bump:terminals（bump-vk-terminals.mjs）から CHANGELOG 自動書き換えを撤去し、依存バージョンの更新のみに変更（changelog 追記はリリース工程で対応）

= 0.5.0 =
- [ 機能追加 ] 起動時・VK Terminals 接続時に、サイドバーメニューへ「VK Orchestrator」セクション（task-queue の issue 一覧を開く項目）を POST /api/menu で冪等に投入するように

= 0.4.0 =
- [ 仕様変更 ] assigneeFilter が null/空のときは issue を一切取り込まず、全件取り込みは "all" の明示指定に変更（新規ユーザーの誤取り込みを防止）
- [ 仕様変更 ] vk-terminals を 1.5.2 から 1.9.1 にアップデート

= 0.3.0 =
- [ 機能追加 ] `up` の GUI(Electron) 起動に GPU モード設定（config `vkTerminals.gpu` / env `VK_TERMINALS_GPU`）を追加。`off`（既定・非 macOS）でエラー抑制、`default` で Chromium 任せを選択可能
- [ 機能追加 ] watch モード常駐中の OS スリープを防止（macOS は caffeinate、Windows は SetThreadExecutionState。orchestrator 終了で自動解除。`VK_ORCHESTRATOR_NO_KEEP_AWAKE=1` で無効化可）
- [ 仕様変更 ] 手動マージ時のメタ issue クローズ手順に前提チェック（closed / status:done ならスキップ・各ステップの冪等化）を追記し、オーケストレーターの自動クローズとのレースによる重複を防止
- [ 仕様変更 ] vk-kore 起動プロンプトの既定テンプレートに headless=1 を追加し、{wpPort} の有無に関わらず無人モードで起動する正式トリガーへ移行（wp-env-port 依存の過渡措置を解消）
- [ 仕様変更 ] 設定 UI からプロトコル（Status 行接頭辞・トークン）/ラベル（status・priority・automerge 等）/wp-env ポート（portBase・portStride）を撤去し、決めうち定数＋config.json 上書きに集約
- [ 不具合修正 ] 非 macOS（WSLg 等）で `up` 実行時に Chromium の GPU 初期化が失敗し、GUI 起動時に `Exiting GPU process` / `kTransientFailure` 等のエラーログが大量に出る不具合を修正（GPU を無効化して抑制。ターミナル用途で描画への影響なし）
- [ 不具合修正 ] GUI 設定パネル保存時に未入力項目が空値（空文字 / 空配列 / null）で書き戻され、`task` / `protocol` / `labels` の既定値を潰してタスク検出・起動が動かなくなる不具合を修正（getter 側で空値を未指定とみなし既定へフォールバック）
- [ セキュリティ修正 ] ペインタイトル送信側（buildPaneTitle 出力）にも制御文字（C0/DEL/C1）除去を追加し、外部由来の issue タイトルを送信前に正規化（多層防御）
- [ その他 ] まっさらな WSL2(WSLg) Ubuntu で動かすためのセットアップ手順（`docs/WSL-UBUNTU-SETUP.md`）を追加し、README 前提に WSL 対応を明記

= 0.2.0 =
- [ 機能追加 ] automerge の e2e 完了ゲートを config でオプション化（`task.requireE2eGate`、既定 true）。false にすると e2e を回さないプロジェクトでもマーカー無しで automerge が進む（CI/CodeRabbit ゲートは維持）
- [ 機能追加 ] 作業ペイン（termId）消失時、対象 issue に PR が未生成なら wp-env 掃除のうえ自動で再実行（`status:ready` へ再キュー）する機能を追加。上限回数（既定 3 回。`orchestrator.paneResumeMax` / `PANE_RESUME_MAX` で上書き可）を超えると従来どおり `status:failed`＋手動確認に
- [ 仕様変更 ] 各ペインのヘッダーに表示する issue 名・リンクを、task-queue の複製 issue ではなく元の作業対象リポジトリの issue のものにするように
- [ 仕様変更 ] 作業対象リポ側の issue に付ける作業中ラベルの既定名を「作業中」から「working」に変更し、GUI 設定項目から撤去（config.json の `labels.workingInProgress` 直書きでのみ上書き可）
- [ その他 ] 未使用だった `labels.e2ePassed` / `e2ePassedShaPrefix` の config・GUI 枠を撤去（マーカー名は `src/github/index.js` の固定定数に集約）
- [ その他 ] 対応 PR の紐付けが PR 本文の `Closes #N` 等の GitHub クローズキーワードを前提とする旨を README の前提に明記
- [ その他 ] エージェント振る舞いルール（automerge での停止禁止・e2e 完了マーカーの付与責務・メタ issue クローズの責務）を `docs/agent-rules.md` として task-queue から移設

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
