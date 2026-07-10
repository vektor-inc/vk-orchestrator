> **注意:** このファイルは https://github.com/vektor-inc/vk-agents で管理されています。内容を変更する場合は、このファイルを直接編集せず、元リポジトリの方で変更してください。

# wp-env 開発環境のルール

## ポート指定は wp-env.json に書かない

`wp-env.json` にポート番号（`port`, `testsPort`）を**直接指定してはいけません**。

ポートを変更したい場合は、必ず `.wp-env.override.json` で上書きしてください。

### 理由

`wp-env.json` はリポジトリにコミットされ、全開発者で共有されます。ポート番号は開発者のローカル環境に依存するため、ここに書くと他の開発者の環境と競合します。`.wp-env.override.json` は `.gitignore` に含まれており、個人の環境設定を安全に管理できます。

### 例

```jsonc
// .wp-env.override.json（ローカルのみ・コミットしない）
{
  "port": 8890,
  "testsPort": 8891
}
```
