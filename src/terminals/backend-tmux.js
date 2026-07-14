// tmux バックエンド。port は無視する。
// 各タスクは split-window でセッションの主 window に並べ、tiled レイアウトで
// 「複数ペインを並べて表示」する（VK Terminals の並列表示に相当）。orchestrator の
// ペインと同じ画面に分割表示されるので、attach した瞬間に分割が見える。termId は pane_id。
// VK Terminals の getStates 形（{terminals:{id:{termId,waiting,lastOutputTime,lastLines}}}）に合わせる。
import { spawnSync } from 'node:child_process';

const CAPTURE_LINES = 40; // capture-pane で取る末尾行数（lastLines のエコー確認に十分な長さ）

function defaultRun(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * @param {object} opts
 * @param {string} opts.session       対象 tmux セッション名
 * @param {string} opts.claudeCommand 新規ペインで起動する Claude コマンド
 * @param {(args:string[])=>{status:number,stdout:string,stderr:string}} [opts.run] tmux ランナー（テスト差し替え用）
 */
export function createTmuxBackend({ session, claudeCommand, run = defaultRun }) {
  // 生成したペインのみ追跡する（orchestrator ペインやユーザーが開いたものは対象外）。
  const panes = new Map(); // paneId -> { waiting: boolean }

  async function checkHealth() {
    return run(['has-session', '-t', session]).status === 0;
  }

  async function createNewPane(_port, cwd = null, options = {}) {
    const launch = [];
    if (cwd) launch.push('-c', cwd);
    if (!options.noClaude) launch.push('--', 'sh', '-c', claudeCommand);

    // セッションの主 window を分割して新しいペインを作り、タイル配置に整える。
    const r = run(['split-window', '-t', session, '-P', '-F', '#{pane_id}', ...launch]);
    const paneId = r.stdout.trim();
    if (r.status !== 0 || !paneId) throw new Error(`tmux split-window failed: ${r.stderr || 'no pane id'}`);
    run(['select-layout', '-t', session, 'tiled']);
    // 各ペインの上部にタイトル（タスク名）を出せるようにする（冪等）。
    run(['set-window-option', '-t', session, 'pane-border-status', 'top']);

    panes.set(paneId, { waiting: false });
    return paneId;
  }

  async function sendToTerminal(_port, termId, input) {
    if (input === '\r' || input === '\n') {
      run(['send-keys', '-t', termId, 'Enter']);
    } else {
      run(['send-keys', '-t', termId, '-l', '--', input]);
    }
    return { ok: true };
  }

  async function getStates() {
    // セッション内の全ペインの最終活動時刻を集める（活動は window 単位のため、
    // 同じ tasks window のペインは値を共有する＝どれか動いていれば全体が活きている扱い）。
    const r = run(['list-panes', '-s', '-t', session, '-F', '#{pane_id} #{window_activity}']);
    const activity = new Map();
    for (const line of r.stdout.split('\n')) {
      const [id, sec] = line.trim().split(/\s+/);
      if (id) activity.set(id, Number(sec) || 0);
    }
    const terminals = {};
    for (const [paneId, state] of panes) {
      if (!activity.has(paneId)) {
        // ペインが消えた → 報告しない（pane-missing 検知に乗る）＋ 内部 Map からも除去
        //（tmux の pane id は再利用されないため安全）。
        panes.delete(paneId);
        continue;
      }
      const cap = run(['capture-pane', '-p', '-t', paneId, '-S', `-${CAPTURE_LINES}`]);
      const sec = activity.get(paneId);
      terminals[paneId] = {
        termId: paneId,
        waiting: state.waiting,
        // 秒→ms（VK Terminals は Date.now() ms）。activity が 0/欠損なら「今」を使う（0 だと watchdog が巨大な idle 時間を計算してしまう）
        lastOutputTime: sec > 0 ? sec * 1000 : Date.now(),
        lastLines: cap.stdout,
      };
    }
    return { terminals };
  }

  async function setExternalWaiting(_port, termId, waiting) {
    const p = panes.get(String(termId));
    if (p) p.waiting = !!waiting;
    return { ok: true };
  }

  async function setTerminalTitle(_port, termId, title) {
    if (title) run(['select-pane', '-t', termId, '-T', String(title)]);
    return { ok: true };
  }

  // 飾り系。tmux では表示対象が無いので no-op。
  async function setTerminalPrUrl() { return { ok: true }; }
  async function postMenu() { return { ok: true }; }

  return {
    checkHealth, getStates, createNewPane, sendToTerminal,
    setTerminalTitle, setTerminalPrUrl, setExternalWaiting, postMenu,
  };
}
