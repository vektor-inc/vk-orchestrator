# Vendor サブモジュールのライセンス一覧

`vendor/` 配下の各ディレクトリは git submodule として外部リポジトリを取り込んだものです。それぞれのライセンスと取得元は以下のとおりです。

ライセンス全文は各 submodule 内の LICENSE ファイルを参照してください。

| submodule（vendor/） | ライセンス | Copyright | 取得元 URL | LICENSE ファイル |
|---|---|---|---|---|
| `ui-ux-pro-max-skill` | MIT | Copyright (c) 2024 Next Level Builder | https://github.com/nextlevelbuilder/ui-ux-pro-max-skill | `vendor/ui-ux-pro-max-skill/LICENSE` |
| `claude-code-owasp` | MIT | Copyright (c) 2026 | https://github.com/agamm/claude-code-owasp | `vendor/claude-code-owasp/LICENSE` |
| `security-audit-skill` | CC BY-SA 4.0 | Copyright (c) 2025-2026 Netresearch DTT GmbH | https://github.com/netresearch/security-audit-skill | `vendor/security-audit-skill/LICENSE-CC-BY-SA-4.0`（MIT 版の `LICENSE-MIT` も同梱） |
| `claude-wordpress-skills` | MIT | Copyright (c) 2025（LICENSE 内の表記は "Your Name" のまま） | https://github.com/elvismdev/claude-wordpress-skills | `vendor/claude-wordpress-skills/LICENSE` |

## ライセンス上の注意

- **`security-audit-skill` は CC BY-SA 4.0（コピーレフト系）です。** 改変・再配布を行う場合は、原作者のクレジット表示（表示義務）に加えて、改変物を同じ CC BY-SA 4.0 で公開する継承義務があります。取り扱いには注意してください。なお、このリポジトリでは submodule として参照しているだけで `vendor/` 内のファイルは直接編集しません（[README.md の「Vendor サブモジュールの更新」](README.md#vendor-サブモジュールの更新) を参照）。
- 上記以外の3つ（`ui-ux-pro-max-skill` / `claude-code-owasp` / `claude-wordpress-skills`）は MIT ライセンスです。MIT は著作権表示とライセンス文の保持を条件に、利用・改変・再配布が広く認められます。
