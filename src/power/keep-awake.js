// -------------------------------------------------------
// スリープ防止（keep-awake）
//
// orchestrator は watch モードで常駐して GitHub を定期ポーリングし、その配下で
// Claude セッションを駆動する。OS がアイドルスリープに入るとポーリングごと止まって
// しまうため、watch 中は OS ごとの方法でシステムスリープを抑止する。
//
// クロスプラットフォーム方針（Windows・macOS どちらのメンバーも同じ orchestrator を使う）:
//   - macOS  … 標準コマンド `caffeinate`（追加インストール不要）を子プロセスで起動する
//   - Windows … PowerShell 経由で Win32 API `SetThreadExecutionState` を呼ぶ
//   - それ以外 … 自動対応はせず警告のみ（OS 側で各自設定）
//
// いずれも「orchestrator（親 PID）が終了したら抑止も自動解除される」形にしている
// （caffeinate は `-w <pid>`、Windows は `Wait-Process -Id <pid>`）。これにより
// orchestrator が SIGKILL 等で異常終了しても、スリープ抑止プロセスが孤児として残り
// マシンが永久に眠らなくなる事故を防ぐ。graceful shutdown 時は stop() で即時解放する。
//
// spawn / platform / logger は依存注入できるようにし、実際に子プロセスを起動せず
// ユニットテストで引数組み立てと分岐を検証できるようにしている。
// -------------------------------------------------------

import { spawn as nodeSpawn } from 'child_process';

// スリープ防止を明示的に無効化する環境変数。各自で電源管理している場合や、
// CI・検証環境などで抑止を切りたいときに `=1` を設定する。
export const KEEP_AWAKE_DISABLE_ENV = 'VK_ORCHESTRATOR_NO_KEEP_AWAKE';

// macOS 用: caffeinate に渡す引数を組み立てる。
//   -i          … システムのアイドルスリープを防止（本来の目的。画面は消えてよい）
//   -s          … （AC 電源時）システムスリープも防止
//   -w <pid>    … 指定 PID のプロセス終了まで待ち、終わったら caffeinate 自身も終了する
//                 （orchestrator 連動での自己後始末。孤児プロセスを残さない）
export function buildCaffeinateArgs(pid) {
  return ['-i', '-s', '-w', String(pid)];
}

// Windows 用: PowerShell に渡すワンライナースクリプトを組み立てる。
// SetThreadExecutionState で ES_CONTINUOUS(0x80000000) | ES_SYSTEM_REQUIRED(0x00000001)
// を立ててシステムスリープを抑止し、orchestrator（親 PID）の終了を Wait-Process で待つ。
// プロセスが終わるとスクリプトも終了し、スレッド終了に伴い実行状態フラグが自動解除される。
export function buildPowerShellScript(pid) {
  return [
    // kernel32 の SetThreadExecutionState を P/Invoke で使えるようにする。
    "$sig = '[DllImport(\"kernel32.dll\", SetLastError = true)] public static extern uint SetThreadExecutionState(uint esFlags);';",
    '$p = Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru;',
    // ES_CONTINUOUS | ES_SYSTEM_REQUIRED = 0x80000001 を立てる（戻り値は破棄）。
    '[void]$p::SetThreadExecutionState([uint32]"0x80000001");',
    // 親（orchestrator）の終了を待つ。終了すればこのスクリプトも終わりフラグが解除される。
    `Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue;`,
  ].join(' ');
}

// スリープ防止を開始する。戻り値の handle.stop() で即時解除できる。
// 起動に失敗しても致命扱いせず（orchestrator 本処理を止めない）、警告だけ出して
// 何もしない handle を返す。
//
// @param {object}   [opts]
// @param {string}   [opts.platform=process.platform] 判定に使うプラットフォーム
// @param {number}   [opts.pid=process.pid]           抑止を連動させる親プロセス PID
// @param {object}   [opts.env=process.env]           無効化フラグの参照元
// @param {Function} [opts.spawn=child_process.spawn] 子プロセス起動関数（テスト差し替え用）
// @param {object}   [opts.logger=console]            ログ出力先（log / warn）
// @returns {{ stop: () => void, child: object|null, platform: string }}
export function startKeepAwake({
  platform = process.platform,
  pid = process.pid,
  env = process.env,
  spawn = nodeSpawn,
  logger = console,
} = {}) {
  // 何もしない（no-op）handle。無効化・未対応・起動失敗時に返す。
  const noop = { stop() {}, child: null, platform };

  // 明示的な無効化。
  if (env[KEEP_AWAKE_DISABLE_ENV] === '1') {
    logger.log?.(`[keep-awake] ${KEEP_AWAKE_DISABLE_ENV}=1 のためスリープ防止を無効化しています。`);
    return noop;
  }

  let child = null;
  try {
    if (platform === 'darwin') {
      // stdio: 'ignore' で caffeinate の出力を捨てる（orchestrator のログを汚さない）。
      child = spawn('caffeinate', buildCaffeinateArgs(pid), { stdio: 'ignore' });
      logger.log?.('[keep-awake] macOS: caffeinate でシステムスリープを防止します（orchestrator 終了で自動解除）。');
    } else if (platform === 'win32') {
      child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', buildPowerShellScript(pid)],
        { stdio: 'ignore' }
      );
      logger.log?.('[keep-awake] Windows: SetThreadExecutionState でシステムスリープを防止します（orchestrator 終了で自動解除）。');
    } else {
      // Linux 等は自動対応しない（OS ごとに手段が分かれるため）。運用者が気づけるよう警告のみ。
      logger.warn?.(`[keep-awake] このプラットフォーム (${platform}) では自動スリープ防止に対応していません。OS 側の電源設定で対応してください。`);
      return noop;
    }
  } catch (err) {
    // 実行ファイルが見つからない等で spawn が同期例外を投げるケース。致命扱いしない。
    logger.warn?.(`[keep-awake] スリープ防止プロセスの起動に失敗しました（処理は継続）: ${err.message}`);
    return noop;
  }

  // spawn 成功後に非同期で発火する error（ENOENT・権限エラー等）も握りつぶさず警告する。
  child.on?.('error', (err) => {
    logger.warn?.(`[keep-awake] スリープ防止プロセスでエラーが発生しました（処理は継続）: ${err.message}`);
  });

  // 二重 kill を防ぐためのフラグ。
  let stopped = false;
  const stop = () => {
    if (stopped || !child) return;
    stopped = true;
    try {
      child.kill();
    } catch {
      // 既に終了済み等。無視してよい。
    }
  };

  return { stop, child, platform };
}
