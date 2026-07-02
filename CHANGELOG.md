# Changelog

- [ 機能追加 ] `up` 起動時に vk-terminals(GUI) のタイトルバー ⚙ ボタンから統合 `config.json` を編集・保存できる設定パネルを追加。`up` が設定ディスクリプタ（編集対象パス + 項目スキーマ）を書き出し、環境変数 `VK_TERMINALS_SETTINGS` で GUI に渡す。これにより GitHub トークン等を手編集せず GUI 上で設定できる（保存後、orchestrator の再起動で反映）
