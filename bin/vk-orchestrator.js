#!/usr/bin/env node
// vk-orchestrator CLI エントリ。
//
// これまで task-queue の `npm start` / `run-once` / check-status.mjs / unblock.mjs に
// 分かれていた入口を 1 つの CLI に統合する。サブコマンド:
//
//   vk-orchestrator start [--once] [--assignee <login>]
//   vk-orchestrator check-status
//   vk-orchestrator unblock <issue-number>
//
// dotenv の読み込みはここで最初に行い、以降のモジュールは src/config.js 経由で設定を取得する。

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// リポジトリ直下の .env を読む（bin/ の一つ上）。
// 依存未インストール（npm install 前）でもヘルプ表示は動くよう、読み込み失敗は握りつぶす。
try {
  const { config: loadDotenv } = await import('dotenv');
  loadDotenv({ path: resolve(__dirname, '..', '.env') });
} catch {
  // dotenv 未インストール時は環境変数をそのまま使う。
}

// 統合設定(config.json)を読み込み、env に反映する（env > config.json > 既定）。
// config.js は Node 標準モジュールのみに依存するため npm install 前でも安全。
const { loadUnifiedConfig, applyConfigToEnv } = await import('../src/config.js');
const unifiedConfig = loadUnifiedConfig();
applyConfigToEnv(unifiedConfig);

const [, , sub] = process.argv;

// 移設した engine 側スクリプトは import しただけで自走する（副作用実行）。
// --once / --assignee 等のフラグは各スクリプトが process.argv を直接読むため、
// ここではサブコマンド名の分岐だけを行い、対応スクリプトを動的 import する。
async function main() {
  switch (sub) {
    case 'start':
      await import('../src/engine/index.js');
      break;
    case 'check-status':
      await import('../src/engine/check-status.mjs');
      break;
    case 'unblock':
      await import('../src/engine/unblock.mjs');
      break;
    case 'apply': {
      // 統合設定の vkTerminals セクションから ~/.vk-terminals/config.json を書き出す。
      const { mkdirSync, writeFileSync } = await import('fs');
      const { dirname: pdirname } = await import('path');
      const { toVkTerminalsConfig, vkTerminalsConfigPath } = await import('../src/config.js');
      const target = vkTerminalsConfigPath();
      const body = JSON.stringify(toVkTerminalsConfig(unifiedConfig), null, 2) + '\n';
      mkdirSync(pdirname(target), { recursive: true });
      writeFileSync(target, body);
      console.log(`vk-terminals 設定を書き出しました → ${target}`);
      break;
    }
    default:
      console.log(`vk-orchestrator <command>

commands:
  start [--once] [--assignee <login>]   キューを監視して実行（--once で 1 周のみ）
  check-status                          現在のキュー／pane 状態を表示
  unblock                               waiting-input の issue を status:ready に戻す
  apply                                 config.json の vkTerminals 設定を ~/.vk-terminals/config.json へ反映
`);
      process.exit(sub ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
