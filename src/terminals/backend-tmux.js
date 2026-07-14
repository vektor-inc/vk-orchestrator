// tmux バックエンド。1 tmux window = 1 セッション。port は無視する。
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
  // 生成したペインのみ追跡する（初期ウィンドウ・ユーザーが開いた窓は対象外）。
  const panes = new Map(); // winId -> { waiting: boolean }

  async function checkHealth() {
    return run(['has-session', '-t', session]).status === 0;
  }

  async function createNewPane(_port, cwd = null, options = {}) {
    const args = ['new-window', '-t', session, '-P', '-F', '#{window_id}'];
    if (cwd) args.push('-c', cwd);
    if (!options.noClaude) args.push('--', 'sh', '-c', claudeCommand);
    const r = run(args);
    const winId = r.stdout.trim();
    if (r.status !== 0 || !winId) throw new Error(`tmux new-window failed: ${r.stderr || 'no window id'}`);
    panes.set(winId, { waiting: false });
    return winId;
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
    const r = run(['list-windows', '-t', session, '-F', '#{window_id} #{window_activity}']);
    const activity = new Map();
    for (const line of r.stdout.split('\n')) {
      const [id, sec] = line.trim().split(/\s+/);
      if (id) activity.set(id, Number(sec) || 0);
    }
    const terminals = {};
    for (const [winId, state] of panes) {
      if (!activity.has(winId)) {
        // 窓が消えた → 報告しない（pane-missing 検知に乗る）＋ 内部 Map からも除去（tmux の window id は再利用されないため安全）
        panes.delete(winId);
        continue;
      }
      const cap = run(['capture-pane', '-p', '-t', winId, '-S', `-${CAPTURE_LINES}`]);
      const sec = activity.get(winId);
      terminals[winId] = {
        termId: winId,
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
    if (title) run(['rename-window', '-t', termId, '--', String(title)]);
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
