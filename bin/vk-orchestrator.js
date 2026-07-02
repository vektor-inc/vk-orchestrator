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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// 同梱の vk-terminals のインストールディレクトリを解決する。未導入なら分かりやすく終了。
async function resolveVkDirOrExit() {
  const { resolveVkTerminalsDir } = await import('../src/config.js');
  try {
    return resolveVkTerminalsDir();
  } catch {
    console.error(
      'vk-terminals が見つかりません。`npm install` を実行してください' +
      '（vk-terminals は依存として導入されます。macOS 以外では利用できない場合があります）。'
    );
    process.exit(1);
  }
}

// ~/.vk-terminals/config.json が存在すると、vk-terminals の設定探索で
// インストールディレクトリ内 config.json より優先され、反映が効かない。警告する。
async function warnIfShadowedByHomeConfig() {
  const { shadowingHomeConfigPath } = await import('../src/config.js');
  const shadow = shadowingHomeConfigPath();
  if (shadow) {
    console.warn(
      `⚠ ${shadow} が存在します。これは vk-terminals ディレクトリ内 config.json より\n` +
      `  優先されるため、今回書き出した設定が無視されます。反映するには ${shadow} を\n` +
      `  削除（またはリネーム）してください。`
    );
  }
}

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
      // 統合設定の vkTerminals セクションから、vk-terminals のインストールディレクトリ内
      // config.json を書き出す。
      const { writeVkTerminalsConfig } = await import('../src/config.js');
      const vkDir = await resolveVkDirOrExit();
      const target = writeVkTerminalsConfig(unifiedConfig, vkDir);
      console.log(`vk-terminals 設定を書き出しました → ${target}`);
      await warnIfShadowedByHomeConfig();
      break;
    }
    case 'up': {
      // 設定を反映したうえで、同梱の vk-terminals(GUI) を起動し、その GUI の中に
      // orchestrator 用ペインを1つ開いて `vk-orchestrator start` を走らせる。
      //
      // orchestrator を外部ターミナル（npm start を叩いた端末）の子プロセスにするのではなく、
      // GUI 内の素のシェルペイン（noClaude）で動かすことで、
      //   - ペインタイトルに「オーケストレーター」が立ち（他ペインと一目で区別できる）
      //   - GUI を閉じればペインごと orchestrator も終了する
      // という運用になる。これで「ペインを開いて claude を止めて start を打つ」手動手順が不要になる。
      //
      // API が listen してからでないとペイン作成もできないため、waitForHealth で疎通を待つ。
      // GUI だけ起動したい場合は `--no-orchestrator` を付ける。
      const { spawn } = await import('child_process');
      const { writeVkTerminalsConfig, writeSettingsDescriptor, resolveConfigPath } =
        await import('../src/config.js');
      const { waitForHealth, createNewPane, sendToTerminal } =
        await import('../src/terminals/index.js');

      const vkDir = await resolveVkDirOrExit();
      const target = writeVkTerminalsConfig(unifiedConfig, vkDir);
      console.log(`vk-terminals 設定を反映しました → ${target}`);
      await warnIfShadowedByHomeConfig();

      // GUI の設定パネルから統合 config.json を直接編集できるよう、設定ディスクリプタを
      // 書き出し、env VK_TERMINALS_SETTINGS でそのパスを GUI へ渡す。
      const configPath = resolveConfigPath();
      const descriptorPath = writeSettingsDescriptor(vkDir, configPath);
      console.log(`設定パネル用ディスクリプタを書き出しました → ${descriptorPath}（編集対象: ${configPath}）`);

      const startOrchestrator = !process.argv.includes('--no-orchestrator');

      console.log(`vk-terminals(GUI) を起動します（${vkDir}）...`);
      const gui = spawn('npm', ['start'], {
        cwd: vkDir,
        stdio: 'inherit',
        env: { ...process.env, VK_TERMINALS_SETTINGS: descriptorPath },
      });
      gui.on('exit', (code) => process.exit(code ?? 0));

      if (startOrchestrator) {
        const port = Number(process.env.VK_TERMINALS_PORT ?? 13847);
        const host = process.env.VK_TERMINALS_HOST ?? '127.0.0.1';
        console.log(`vk-terminals API (${host}:${port}) の起動を待っています...`);
        const healthy = await waitForHealth(port, { timeoutMs: 60_000, intervalMs: 1_000 });

        if (gui.exitCode !== null) break; // 疎通待ちの間に GUI が閉じられた

        if (!healthy) {
          console.warn(
            `[up] vk-terminals API (${host}:${port}) に疎通できませんでした。` +
            `orchestrator ペインは作成しません。\n` +
            `  VK_TERMINALS_HOST / config.json の vkTerminals.host（現在: ${host}）を確認するか、` +
            `GUI 内のペインで手動で \`node ${__filename} start\` を実行してください。`
          );
          break;
        }

        // GUI 内に「claude を起動しない素のシェルペイン」を開き、そこで orchestrator を走らせる。
        // `up` に付いた自前フラグ(--no-orchestrator)以外の引数は start へ引き継ぐ（--assignee 等）。
        const forwarded = process.argv.slice(3).filter((a) => a !== '--no-orchestrator');
        try {
          const repoRoot = resolve(__dirname, '..');
          const termId = await createNewPane(port, repoRoot, { noClaude: true });
          console.log(`orchestrator ペインを作成しました (termId: ${termId})`);

          // 素のシェルの起動を少し待ってからコマンドを流し込む（プロンプト出現前の取りこぼし対策）。
          await new Promise((r) => setTimeout(r, 1_200));

          // 絶対パスの bin を叩くことで、ペインの cwd や PATH/npx 解決に依存せず確実に起動する。
          const cmd = ['node', JSON.stringify(__filename), 'start', ...forwarded].join(' ');
          await sendToTerminal(port, termId, cmd + '\r');
          console.log(`orchestrator を GUI 内ペインで起動しました: ${cmd}`);
        } catch (err) {
          console.warn(
            `[up] orchestrator ペインの作成／起動に失敗しました（GUI は起動済み）: ${err.message}\n` +
            `  GUI 内のペインで手動で \`node ${__filename} start\` を実行してください。`
          );
        }
      }
      break;
    }
    default:
      console.log(`vk-orchestrator <command>

commands:
  up [--no-orchestrator]                config.json を反映し vk-terminals(GUI) と orchestrator を起動
                                        （--no-orchestrator で GUI のみ起動）
  start [--once] [--assignee <login>]   キューを監視して実行（--once で 1 周のみ）
  check-status                          現在のキュー／pane 状態を表示
  unblock                               waiting-input の issue を status:ready に戻す
  apply                                 config.json の vkTerminals 設定を vk-terminals ディレクトリ内 config.json へ反映
`);
      process.exit(sub ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
