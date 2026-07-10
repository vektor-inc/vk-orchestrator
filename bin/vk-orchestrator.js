#!/usr/bin/env node
// VK Orchestrator CLI エントリ。
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

// 同梱の VK Terminals のインストールディレクトリを解決する。未導入なら分かりやすく終了。
async function resolveVkDirOrExit() {
  const { resolveVkTerminalsDir } = await import('../src/config.js');
  try {
    return resolveVkTerminalsDir();
  } catch {
    console.error(
      'VK Terminals が見つかりません（未導入、または optional 依存のビルド失敗で除外されています）。\n' +
      '  導入するには: npm run setup:terminals（ビルドログを表示しながら導入し、結果を検証します）\n' +
      (process.platform === 'darwin'
        ? '  macOS では Xcode Command Line Tools が必要です → `xcode-select --install`'
        : `  現在のプラットフォームは ${process.platform} です。VK Terminals(GUI) は macOS 専用のため\n` +
          '  この環境では起動できません。別マシンの VK Terminals API を使う場合は `up` ではなく\n' +
          '  `start` を使い、config.json の vkTerminals.host を対象マシンに向けてください。')
    );
    process.exit(1);
  }
}

// ~/.vk-terminals/config.json が存在すると、VK Terminals の設定探索で
// インストールディレクトリ内 config.json より優先され、反映が効かない。警告する。
async function warnIfShadowedByHomeConfig() {
  const { shadowingHomeConfigPath } = await import('../src/config.js');
  const shadow = shadowingHomeConfigPath();
  if (shadow) {
    console.warn(
      `⚠ ${shadow} が存在します。これは VK Terminals ディレクトリ内 config.json より\n` +
      `  優先されるため、今回書き出した設定が無視されます。反映するには ${shadow} を\n` +
      `  削除（またはリネーム）してください。`
    );
  }
}

const ORCHESTRATOR_REPO_URL = 'https://github.com/vektor-inc/vk-orchestrator.git';

// up 起動時に vk-orchestrator 自身を最新リリースへ追従させる。
//
// リモートの最新 semver タグは「更新要否の判定材料」としてだけ使い、実際の更新は
// main ブランチ上で `git pull --ff-only` に限定する。dirty / 非 main / ff 不可など、
// 開発者の作業や履歴を壊しうる状況では警告して現行プロセスのまま起動を続行する。
async function reconcileOrchestratorVersion() {
  const repoRoot = resolve(__dirname, '..');
  const alreadyUpdated = process.env.VK_ORCHESTRATOR_SELF_UPDATED === '1';
  const optOut = process.env.VK_ORCHESTRATOR_NO_AUTO_UPDATE === '1';

  if (alreadyUpdated) {
    console.log('[up] vk-orchestrator は再起動後のため自己更新チェックをスキップします。');
    return;
  }
  if (optOut) {
    console.log('[up] VK_ORCHESTRATOR_NO_AUTO_UPDATE=1 のため vk-orchestrator の自己更新をスキップします。');
    return;
  }

  const { readFileSync } = await import('fs');
  let current = null;
  try {
    current = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;
  } catch {
    console.warn('[up] vk-orchestrator の package.json を読めませんでした。自己更新をスキップします。');
    return;
  }

  console.log('[up] vk-orchestrator の自己更新を確認します...');

  let latest = null;
  try {
    const { fetchTags, latestSemverTag } = await import('../scripts/vk-terminals-tags.mjs');
    latest = latestSemverTag(fetchTags(ORCHESTRATOR_REPO_URL, { cwd: repoRoot }));
  } catch {
    console.warn('[up] vk-orchestrator のリモート照会に失敗しました（オフライン等）。現行版で起動します。');
    return;
  }

  const { orchestratorUpdateDecision } = await import('../src/engine/self-update.js');
  const versionDecision = orchestratorUpdateDecision({ current, latest, branch: 'main' });
  if (versionDecision.action === 'skip') {
    if (versionDecision.reason === 'up-to-date') {
      console.log(`[up] vk-orchestrator は最新です（現在: ${current}, 最新: ${latest}）。`);
    } else {
      console.warn('[up] vk-orchestrator の更新対象タグを判定できませんでした。現行版で起動します。');
    }
    return;
  }

  const { spawnSync } = await import('child_process');
  const gitOutput = (args) => {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (r.status !== 0) return null;
    return r.stdout.trim();
  };
  const gitBlobHash = (path) => gitOutput(['rev-parse', `HEAD:${path}`]);

  const status = gitOutput(['status', '--porcelain']);
  if (status == null) {
    console.warn('[up] vk-orchestrator の git 状態を確認できませんでした。自己更新をスキップします。');
    return;
  }
  const branch = gitOutput(['branch', '--show-current']);
  if (branch == null) {
    console.warn('[up] vk-orchestrator の現在ブランチを確認できませんでした。自己更新をスキップします。');
    return;
  }

  const decision = orchestratorUpdateDecision({
    current,
    latest,
    dirty: status !== '',
    branch,
    optOut,
    alreadyUpdated,
  });
  if (decision.action === 'skip') {
    if (decision.reason === 'dirty') {
      console.warn('[up] 未コミット変更を守るため vk-orchestrator の自己更新をスキップします。現行版で起動します。');
    } else if (decision.reason === 'non-main-branch') {
      console.warn(`[up] 現在のブランチが main ではないため vk-orchestrator の自己更新をスキップします（現在: ${branch || '(detached)'}）。`);
    } else {
      console.warn('[up] vk-orchestrator の自己更新条件を満たさないためスキップします。現行版で起動します。');
    }
    return;
  }

  const beforeLock = gitBlobHash('package-lock.json');
  console.log(`[up] vk-orchestrator ${current} → ${latest} が見つかりました。main を ff 追従します...`);
  const pull = spawnSync('git', ['pull', '--ff-only'], { cwd: repoRoot, stdio: 'inherit' });
  if (pull.status !== 0) {
    console.warn('[up] vk-orchestrator の git pull --ff-only に失敗しました。現行版で起動します。');
    return;
  }

  const afterLock = gitBlobHash('package-lock.json');
  if (beforeLock !== afterLock) {
    console.log('[up] package-lock.json が更新されたため npm install を実行します...');
    const install = spawnSync('npm', ['install'], { cwd: repoRoot, stdio: 'inherit' });
    if (install.status !== 0) {
      console.warn(
        '[up] npm install に失敗しました。現行プロセスのまま起動を続行します。\n' +
        '  手動で `npm install` を実行してください。'
      );
      return;
    }
  }

  console.log('[up] vk-orchestrator の自己更新が完了しました。新しいコードで再起動します...');
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, VK_ORCHESTRATOR_SELF_UPDATED: '1' },
  });
  if (child.error) {
    console.warn(`[up] vk-orchestrator の再起動に失敗しました。現行プロセスのまま起動を続行します: ${child.error.message}`);
    return;
  }
  process.exit(child.status ?? 1);
}

// up 起動時に vk-terminals を最新へ追従させる。
//
// 既定では GitHub のリモートタグを見て最新 semver を導入対象とし、node_modules に
// 入っている version とズレていれば（または未導入なら）その版を入れ直す。これにより
// vk-terminals 側がタグを打つだけで、各ユーザーは `up` するだけで最新 GUI に上がる
// （orchestrator の package.json bump / push / pull が不要になる）。
//
// 追従対象の決め方（優先順）:
//   1. env VK_TERMINALS_TAG="1.5.2" … 明示ピン／ロールバック。リモート照会せずこの版に固定。
//   2. env VK_TERMINALS_NO_AUTO_UPDATE=1 … 自動追従を無効化し package.json 固定タグに照合（従来動作。オフライン向け）。
//   3. 既定 … リモートの最新 semver タグ。照会失敗時は package.json 固定タグへフォールバック。
//
// インストールは `npm install vk-terminals@…#<タグ> --no-save` で行う。--no-save により
// ユーザーの clone の package.json / lock を汚さず node_modules だけ差し替える。
// --include=optional を付けないと git 依存の optional build が走らない点に注意。
async function reconcileVkTerminalsVersion() {
  const { readFileSync } = await import('fs');
  const repoRoot = resolve(__dirname, '..');

  // package.json 固定タグ（フォールバック用）。spec "git+…#<タグ>" から取り出す。
  let pinnedTag = null;
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    const spec =
      pkg.optionalDependencies?.['vk-terminals'] ?? pkg.dependencies?.['vk-terminals'] ?? '';
    pinnedTag = spec.match(/#(.+)$/)?.[1] ?? null;
  } catch {
    return; // package.json が読めない状況では何もしない
  }

  // 実際に入っている version（未導入なら null）。
  let installed = null;
  try {
    const { resolveVkTerminalsDir } = await import('../src/config.js');
    installed = JSON.parse(
      readFileSync(resolve(resolveVkTerminalsDir(), 'package.json'), 'utf8')
    ).version;
  } catch {
    // 未導入 → 下でインストールする
  }

  // 追従対象タグの決定。
  let targetTag = null;
  const envTag = process.env.VK_TERMINALS_TAG?.trim();
  const autoUpdate = process.env.VK_TERMINALS_NO_AUTO_UPDATE !== '1';
  if (envTag) {
    targetTag = envTag; // 明示ピン
  } else if (autoUpdate) {
    try {
      const { fetchTags, latestSemverTag } = await import('../scripts/vk-terminals-tags.mjs');
      targetTag = latestSemverTag(fetchTags());
      if (!targetTag) {
        console.warn('[up] vk-terminals のリモート最新タグを解決できませんでした。固定タグにフォールバックします。');
      }
    } catch {
      console.warn('[up] vk-terminals のリモート照会に失敗しました（オフライン等）。固定タグにフォールバックします。');
    }
  }
  targetTag ??= pinnedTag; // 未解決なら package.json 固定タグ

  // 照合できるのはタグが semver（"1.5.1" / "v1.5.1"）で version と比較できる場合のみ。
  const normTag = targetTag?.replace(/^v/, '');
  const isSemverTag = normTag != null && /^\d+\.\d+\.\d+$/.test(normTag);

  if (installed && !isSemverTag) return; // SHA 固定等は照合不能なのでスキップ
  if (installed && isSemverTag && installed === normTag) return; // 既に対象版 → 何もしない
  if (!targetTag) return; // 導入対象が決められない

  const spec = `vk-terminals@git+https://github.com/vektor-inc/vk-terminals.git#${targetTag}`;
  const { spawnSync } = await import('child_process');
  console.log(
    installed
      ? `vk-terminals を更新します（導入済み: ${installed} → 対象: ${targetTag}）...`
      : `vk-terminals が未導入です。${targetTag} をインストールします...`
  );
  const r = spawnSync(
    'npm',
    ['install', spec, '--no-save', '--include=optional', '--foreground-scripts'],
    { cwd: repoRoot, stdio: 'inherit' }
  );
  if (r.status !== 0) {
    console.warn(
      '[up] vk-terminals のインストールに失敗しました。古い版のまま起動する可能性があります。\n' +
      '  手動で `npm run setup:terminals` を実行してください。'
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
      // 統合設定の vkTerminals セクションから、VK Terminals のインストールディレクトリ内
      // config.json を書き出す。vk-agents 共通設定も同じ apply/up タイミングで投影する。
      const { writeVkTerminalsConfig, writeVkAgentsSettings } = await import('../src/config.js');
      const vkDir = await resolveVkDirOrExit();
      const target = writeVkTerminalsConfig(unifiedConfig, vkDir);
      console.log(`VK Terminals 設定を書き出しました → ${target}`);
      const vkAgents = writeVkAgentsSettings(unifiedConfig);
      if (vkAgents) {
        console.log(`vk-agents 設定を書き出しました → ${vkAgents.configPath}`);
        console.log(`vk-agents 派生設定を書き出しました → ${vkAgents.globalSettingsPath}`);
      } else {
        console.warn('[apply] vk-agents 設定の投影はスキップしました（config.json 未作成、またはパス未解決）。');
      }
      await warnIfShadowedByHomeConfig();
      break;
    }
    case 'up': {
      // 設定を反映したうえで、同梱の VK Terminals(GUI) を起動し、その GUI の中に
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
      const { writeVkTerminalsConfig, writeVkAgentsSettings, writeSettingsDescriptor, resolveConfigPath,
        getVkTerminalsGpuMode, gpuLaunchOptions } =
        await import('../src/config.js');
      const { waitForHealth, createNewPane, sendToTerminal } =
        await import('../src/terminals/index.js');

      // GUI 起動前に、orchestrator 自身と固定タグ・実際に入っている版のズレを解消しておく。
      await reconcileOrchestratorVersion();
      await reconcileVkTerminalsVersion();

      const vkDir = await resolveVkDirOrExit();
      const target = writeVkTerminalsConfig(unifiedConfig, vkDir);
      console.log(`VK Terminals 設定を反映しました → ${target}`);
      const vkAgents = writeVkAgentsSettings(unifiedConfig);
      if (vkAgents) {
        console.log(`vk-agents 設定を反映しました → ${vkAgents.configPath}`);
        console.log(`vk-agents 派生設定を反映しました → ${vkAgents.globalSettingsPath}`);
      } else {
        console.warn('[up] vk-agents 設定の投影はスキップしました（config.json 未作成、またはパス未解決）。');
      }
      await warnIfShadowedByHomeConfig();

      // GUI の設定パネルから統合 config.json を直接編集できるよう、設定ディスクリプタを
      // 書き出し、env VK_TERMINALS_SETTINGS でそのパスを GUI へ渡す。
      const configPath = resolveConfigPath();
      const descriptorPath = writeSettingsDescriptor(vkDir, configPath);
      console.log(`設定パネル用ディスクリプタを書き出しました → ${descriptorPath}（編集対象: ${configPath}）`);

      const startOrchestrator = !process.argv.includes('--no-orchestrator');

      // GUI(Electron) の GPU 起動モードを解決し、電子へ渡すフラグと追加 env を組み立てる。
      // 既定は非 macOS で 'off'（Chromium の GPU 初期化失敗による `Exiting GPU process`
      // 等のエラーログを抑制。描画はソフトウェアだがターミナル用途で実害なし）。
      // config `vkTerminals.gpu` / env `VK_TERMINALS_GPU` で 'hardware'（WSLg の d3d12
      // 経由 HW OpenGL）/ 'default'（Chromium 任せ）へ切り替え可能。
      // フラグは `npm start -- <flags>` で `electron .` 側へ渡す。
      const gpuMode = getVkTerminalsGpuMode(unifiedConfig);
      const { args: gpuArgs, env: gpuEnv } = gpuLaunchOptions(gpuMode);
      const guiArgs = gpuArgs.length ? ['start', '--', ...gpuArgs] : ['start'];

      console.log(`VK Terminals(GUI) を起動します（${vkDir}, gpu=${gpuMode}）...`);
      const gui = spawn('npm', guiArgs, {
        cwd: vkDir,
        stdio: 'inherit',
        env: { ...process.env, ...gpuEnv, VK_TERMINALS_SETTINGS: descriptorPath },
      });
      gui.on('exit', (code) => process.exit(code ?? 0));

      if (startOrchestrator) {
        const port = Number(process.env.VK_TERMINALS_PORT ?? 13847);
        const host = process.env.VK_TERMINALS_HOST ?? '127.0.0.1';
        console.log(`VK Terminals API (${host}:${port}) の起動を待っています...`);
        const healthy = await waitForHealth(port, { timeoutMs: 60_000, intervalMs: 1_000 });

        if (gui.exitCode !== null) break; // 疎通待ちの間に GUI が閉じられた

        if (!healthy) {
          console.warn(
            `[up] VK Terminals API (${host}:${port}) に疎通できませんでした。` +
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
          // orchestrator ペインは常時監視するものではないためサイドバーに格納して開く。
          // VK Terminals が stashed 未対応の版では未知フィールドとして無視される。
          const termId = await createNewPane(port, repoRoot, { noClaude: true, stashed: true });
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
    case 'setup-terminals': {
      // VK Terminals を明示的に導入する。optionalDependencies はビルド失敗でも
      // npm が exit 0 を返して黙って除外するため、通常の `npm install` だと
      // 「入ったつもりで入っていない」状態に気づけない。ここではビルドログを
      // 表示（--foreground-scripts）したうえで、実際に解決できるかで成否を判定する。
      const { spawnSync } = await import('child_process');
      const { resolveVkTerminalsDir } = await import('../src/config.js');
      const repoRoot = resolve(__dirname, '..');

      if (process.platform !== 'darwin') {
        console.warn(
          `⚠ 現在のプラットフォームは ${process.platform} です。VK Terminals(GUI) は node-pty /\n` +
          `  electron のネイティブビルドを伴い macOS 専用です。macOS 以外では GUI を起動できません。\n` +
          `  別マシンの VK Terminals API を叩く構成（vkTerminals.host 指定 + start）なら導入は不要です。\n`
        );
      }

      console.log('VK Terminals を導入します（ビルドログを表示します）...\n');
      spawnSync('npm', ['install', '--foreground-scripts', '--include=optional'], {
        cwd: repoRoot,
        stdio: 'inherit',
      });

      try {
        const dir = resolveVkTerminalsDir();
        console.log(`\n✅ VK Terminals を導入しました → ${dir}`);
      } catch {
        console.error(
          '\n❌ VK Terminals の導入に失敗しました（optional 依存のビルドが失敗し除外されています）。\n' +
          '   上のビルドログのエラーを確認してください。よくある原因:\n' +
          (process.platform === 'darwin'
            ? '   - Xcode Command Line Tools 未導入 → `xcode-select --install` を実行して再試行\n'
            : `   - macOS 以外のため node-pty / electron をビルドできない（GUI は macOS のみ対応）\n`) +
          '   - C/C++ ビルドツール不足、または clone 時のネットワークエラー'
        );
        process.exit(1);
      }
      break;
    }
    default:
      console.log(`vk-orchestrator <command>

commands:
  up [--no-orchestrator]                config.json を反映し VK Terminals(GUI) と orchestrator を起動
                                        （--no-orchestrator で GUI のみ起動）
  start [--once] [--assignee <login>]   キューを監視して実行（--once で 1 周のみ）
  check-status                          現在のキュー／pane 状態を表示
  unblock                               waiting-input の issue を status:ready に戻す
  apply                                 config.json の vkTerminals 設定を VK Terminals ディレクトリ内 config.json へ反映
  setup-terminals                       VK Terminals を（ビルドログ付きで）明示的に導入し導入結果を検証
`);
      process.exit(sub ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
