# Changelog

- [ 機能追加 ] 設定パネルの各項目に説明文（help）を追加し、Repo・Queue Label・ウォッチドッグ idle などの意味と入力例を GUI 上で確認できるように
- [ 機能追加 ] `up` 起動時に VK Terminals(GUI) のタイトルバー ⚙ ボタンから統合 `config.json` を編集・保存できる設定パネルを追加。`up` が設定ディスクリプタ（編集対象パス + 項目スキーマ）を書き出し、環境変数 `VK_TERMINALS_SETTINGS` で GUI に渡す。これにより GitHub トークン等を手編集せず GUI 上で設定できる（保存後、orchestrator の再起動で反映）
- [ 仕様変更 ] ドキュメント・UI 表示・ログ・コメントの製品名表記を VK Orchestrator / VK Terminals に統一（コマンド・パス・パッケージ名などのコード上の識別子は従来どおり小文字）
- [ その他 ] README のセットアップ手順に、初回設定で必須なのは `github.token` / `owner` / `repo` の 3 項目のみで、`vkTerminals.port` / `host` は既定値のままでよい旨を明記
