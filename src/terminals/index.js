import { createServer } from 'net';

import { stripControlChars } from '../engine/build-command.js';

// VK Terminals API の接続先ホスト。既定は localhost。
// VK Terminals が Tailscale IP 等の特定インターフェースだけにバインドしている場合は
// .env の VK_TERMINALS_HOST で接続先を上書きできる。
// 注意: dotenv の config() は index.js の ES import より後に走るため、ここで
// モジュール読み込み時に process.env を固定すると .env の値が間に合わない。
// 必ず「呼び出し時」に読むこと（関数化している理由）。
const apiHost = () => process.env.VK_TERMINALS_HOST ?? '127.0.0.1';
const BASE_URL = (port) => `http://${apiHost()}:${port}`;
const CLEAR_INPUT_SEQUENCE = '\x01\x0b';

/**
 * 自分自身が動作している VK Terminals ペインのタイトルを設定するための
 * OSC 0 エスケープシーケンス文字列を組み立てる。
 *
 * orchestrator（npm start）は自分自身の termId を知らないため、ワーカーペイン用の
 * `/api/set-title`（apiTitle）は使えない。代わりに stdout へ OSC 0/2 を書き込むと
 * VK Terminals(xterm.js) の `onTitleChange` が拾って taskTitle としてペイン上部に
 * 表示する（renderer 側 `getDisplayTitle` は apiTitle || taskTitle。orchestrator の
 * ペインには apiTitle を立てる主体がいないため taskTitle がそのまま表示される）。
 *
 * BEL(\x07) を終端に使う。タイトルに制御文字（特に BEL/ESC）が混じるとシーケンスが
 * 途中で壊れるため、表示不能な制御文字を除去してから埋め込む。除去対象は C0(\x00-\x1f)、
 * DEL(\x7f)、および C1(\x80-\x9f)。8bit C1 を OSC/ST として解釈する端末への多層防御として
 * C1 まで含めて落とす（現状タイトルは静的リテラルだが、将来動的入力を渡しても安全にする）。
 *
 * @param {string} title ペインに表示したいタイトル文字列
 * @returns {string} OSC 0 エスケープシーケンス
 */
export function buildPaneTitleSequence(title) {
  // 制御文字の除去は build-command.js の stripControlChars に集約している（DRY）。
  const safe = stripControlChars(title);
  return `\x1b]0;${safe}\x07`;
}

/**
 * 自分自身のペインタイトルを設定する。
 *
 * stdout が TTY でない（ログファイルへのリダイレクト・パイプ等）場合は、生の
 * エスケープシーケンスで出力を汚さないよう何もしない。
 *
 * @param {string} title 表示したいタイトル
 * @param {NodeJS.WriteStream} [stream=process.stdout] 書き込み先（テスト用に差し替え可能）
 * @returns {boolean} シーケンスを書き込んだら true、TTY でなくスキップしたら false
 */
export function setOwnPaneTitle(title, stream = process.stdout) {
  if (!stream || !stream.isTTY) return false;
  stream.write(buildPaneTitleSequence(title));
  return true;
}

// VK Terminals が起動しているか確認
// timeoutMs: 応答しないホスト（Tailscale IP 未接続など）で fetch が無限にハングして
// 呼び出し側（waitForHealth のポーリング等）が固まるのを防ぐための打ち切り時間。
export async function fetchHealth(port, { timeoutMs = 3_000 } = {}) {
  try {
    const res = await fetch(`${BASE_URL(port)}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json();
    if (!json || typeof json !== 'object') return null;
    const health = { ok: json.ok === true };
    if (typeof json.instanceId === 'string' && json.instanceId !== '') {
      health.instanceId = json.instanceId;
    }
    return health;
  } catch {
    return null;
  }
}

// VK Terminals が起動しているか確認
// 既存呼び出しとの互換性のため boolean 契約を維持する。
export async function checkHealth(port, { timeoutMs = 3_000 } = {}) {
  const health = await fetchHealth(port, { timeoutMs });
  return health?.ok === true;
}

/**
 * OS に空きポートを割り当てさせ、その番号を返す。
 *
 * 戻り値のポートは close 後に再利用されるため、呼び出し元は速やかに対象プロセスへ渡す。
 * timeoutMs は listen/close のコールバックが返らない異常時に Promise が永久 pending となり
 * `up` 全体がハングするのを防ぐ打ち切り時間（fetchHealth 等の timeoutMs と同方針）。
 * @param {string} [host='127.0.0.1'] listen するホスト
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] ポート確保の打ち切り時間
 * @returns {Promise<number>} 使用可能な TCP ポート番号
 */
export function findFreePort(host = '127.0.0.1', { timeoutMs = 3_000 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      server.close(() => {});
      finish(reject, new Error(`findFreePort timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    server.once('error', (err) => finish(reject, err));
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => {
        if (err) {
          finish(reject, err);
          return;
        }
        if (typeof port === 'number') {
          finish(resolve, port);
          return;
        }
        finish(reject, new Error('failed to allocate a free port'));
      });
    });
  });
}

/**
 * VK Terminals health の instanceId が今回起動した GUI のものか判定する。
 *
 * 旧 vk-terminals は instanceId を返さないため、その場合は後方互換として通す。
 * 既知の残存リスク: プリフライト検知〜起動後ポーリングの間に instanceId 非対応の
 * 旧版が同ポートを掴んだ場合、legacy 判定で素通りし誤接続し得る（狭い TOCTOU 窓）。
 * ロールアウトで vk-terminals が id 対応版に揃えば解消する想定。
 * @param {{ ok: boolean, instanceId?: string } | null} health /api/health の結果
 * @param {string} expectedInstanceId 今回起動した GUI に渡した instance id
 * @returns {{ ok: true, mode: 'matched'|'legacy', instanceId?: string } | { ok: false, reason: 'unhealthy'|'instance-mismatch', instanceId?: string }}
 */
export function evaluateHealthInstance(health, expectedInstanceId) {
  if (health?.ok !== true) {
    return { ok: false, reason: 'unhealthy' };
  }
  if (!health.instanceId) {
    return { ok: true, mode: 'legacy' };
  }
  if (health.instanceId !== expectedInstanceId) {
    return { ok: false, reason: 'instance-mismatch', instanceId: health.instanceId };
  }
  return { ok: true, mode: 'matched', instanceId: health.instanceId };
}

/**
 * VK Terminals の HTTP API が healthy になるまでポーリングで待つ。
 *
 * `up` が GUI(Electron)を起動した直後は API サーバーがまだ listen していないため、
 * orchestrator を起動する前にここで疎通を待つ（待たずに起動しても loop() は健全性
 * ゲートで捌くが、初回 dispatch が POLL_INTERVAL 分遅れるのを避けるため）。
 *
 * @param {number} port VK Terminals API ポート
 * @param {object} [options]
 * @param {number}   [options.timeoutMs=60000]  全体タイムアウト
 * @param {number}   [options.intervalMs=1000]  ポーリング間隔
 * @param {(port:number)=>Promise<boolean>} [options.check=checkHealth] 疎通判定（テスト用に差し替え可能）
 * @param {(ms:number)=>Promise<void>} [options.sleep] 待機関数（テスト用に差し替え可能）
 * @returns {Promise<boolean>} healthy を確認できたら true、タイムアウトなら false
 */
export async function waitForHealth(port, options = {}) {
  const {
    timeoutMs  = 60_000,
    intervalMs = 1_000,
    check      = checkHealth,
    sleep      = (ms) => new Promise(r => setTimeout(r, ms)),
  } = options;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check(port)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// 全ターミナルの状態を取得
export async function getStates(port) {
  const res = await fetch(`${BASE_URL(port)}/api/states`);
  return res.json();
}

// 空き（待機中でなく、最近タスクを受け取っていない）ターミナルIDを返す
export async function findIdleTerminal(port, busyTermIds = new Set()) {
  const { terminals } = await getStates(port);
  for (const [, term] of Object.entries(terminals)) {
    if (busyTermIds.has(term.termId)) continue;
    if (term.waiting) continue;
    return term.termId;
  }
  return null;
}

// VK Terminals に新規ペインを作成して termId を返す
//   cwd を指定するとそのディレクトリで開く（未指定なら VK Terminals 側で HOME にフォールバック）。
//   options.noClaude=true を渡すと claude を自動起動せず素のシェルとしてペインを開く
//   （orchestrator 自体をペインで動かす用途など）。
//   options.stashed=true を渡すとサイドバーに格納した状態でペインを開く
//   （VK Terminals が未対応の版では未知フィールドとして無視される）。
export async function createNewPane(port, cwd = null, options = {}) {
  const body = {};
  if (cwd) body.cwd = cwd;
  if (typeof options.noClaude === 'boolean') body.noClaude = options.noClaude;
  if (typeof options.stashed === 'boolean') body.stashed = options.stashed;
  const res = await fetch(`${BASE_URL(port)}/api/new-pane`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? 'new-pane failed');
  return json.termId;
}

// 指定ターミナルにテキストを送信
export async function sendToTerminal(port, termId, input) {
  const res = await fetch(`${BASE_URL(port)}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, input }),
  });
  return res.json();
}

// 指定ターミナルのタスクタイトル行に表示するテキストをセット
// （VK Terminals 側で空文字なら非表示扱い）
/**
 * @param {string|null} [url] タスクに紐づくリンク先 URL。文字列なら body に含めて送信し、
 *   null/undefined なら body に含めない（VK Terminals 旧バージョンとの後方互換のため）。
 */
export async function setTerminalTitle(port, termId, title, url = null) {
  const payload = { termId, title };
  if (typeof url === 'string') payload.url = url;
  const res = await fetch(`${BASE_URL(port)}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json?.error ?? `set-title failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * 指定ターミナルに PR URL をセットする。
 *
 * VK Terminals issue #44 で導入された PR ボタン表示用のフィールド `apiPrUrl` に流し込む。
 * タスク登録リポジトリ側（orchestrator）は PR を検知した時点でこの関数を呼び、ペイン上部の
 * タスクタイトル行から PR ページへ直接ジャンプできるようにする。
 *
 * 実装メモ:
 *   VK Terminals 側は `/api/set-title` の `prUrl` / `prMerged` フィールドで受け取る仕様で、
 *   `title` / `url` / `prUrl` / `prMerged` をペアで置換するセマンティクスを持つ。
 *   そのため prUrl だけ単独更新するには、先に getStates で現在の apiTitle / apiUrl を
 *   取得してから一緒に送り直す必要がある。
 *   prMerged を省略すると VK Terminals 側で false 扱いになり、マージ済み表示は解除される。
 *
 *   呼び出し側 (recordPRAcrossSurfaces) は失敗を warn で握りつぶす運用なので、
 *   状態取得などの途中失敗は throw して上に伝える。
 *
 * @param {number} port           VK Terminals API ポート
 * @param {string|number} termId  対象ターミナル ID
 * @param {string|null} prUrl     PR の HTML URL（クリアしたい場合は空文字）
 * @param {object} [options]
 * @param {boolean} [options.prMerged=false] PR ボタンをマージ済み表示（紫）へ切り替えるフラグ。
 *   既定 false。省略時は VK Terminals 側でも false 扱いになる。
 */
export async function setTerminalPrUrl(port, termId, prUrl, { prMerged = false } = {}) {
  const { terminals } = await getStates(port);
  // /api/states のレスポンス形が想定外（terminals 欠落・非オブジェクト）だと
  // Object.values(undefined) で TypeError になり原因が追いづらいため、
  // 明示的に検証して原因が分かるエラーメッセージを返す。
  if (!terminals || typeof terminals !== 'object') {
    throw new Error(`invalid states response from VK Terminals (port=${port}): terminals missing`);
  }
  const term = Object.values(terminals).find(t => String(t.termId) === String(termId));
  if (!term) {
    throw new Error(`terminal ${termId} not found`);
  }
  const payload = {
    termId,
    title:    term.apiTitle ?? '',
    url:      term.apiUrl   ?? '',
    prUrl:    prUrl ?? '',
    prMerged: prMerged === true,
  };
  const res = await fetch(`${BASE_URL(port)}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `set-title (prUrl) failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * 指定ターミナルの入力待ちマーカー状態を VK Terminals へセットする。
 *
 * externalWaiting は `/api/set-status` だけが更新する。`/api/set-title` は title/url/prUrl の
 * 置換用で waiting を反映しないため、状態引き継ぎのための getStates は不要。
 * VK Terminals 側は waiting を厳密な boolean として検証するため、送信前に `!!` で正規化する。
 *
 * @param {number} port              VK Terminals API ポート
 * @param {string|number} termId     対象ターミナル ID
 * @param {*} waiting                入力待ちマーカーを点灯するなら truthy、消灯するなら falsy
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function setExternalWaiting(port, termId, waiting) {
  const res = await fetch(`${BASE_URL(port)}/api/set-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, waiting: !!waiting }),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `set-status failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * 指定ペインの閉じる保護（close ロック）を設定する。
 *
 * `lock: { close: false }` で閉じる操作を保護し、`lock: null` で解除する。
 * `/api/set-lock` は VK Terminals 1.21.0 で導入されたため、未対応の旧版では
 * 404 等で throw する。ロックが必須でない呼び出し側は失敗を握りつぶし、
 * graceful degradation で継続する想定。
 *
 * @param {number} port          VK Terminals API ポート
 * @param {string|number} termId 対象ターミナル ID
 * @param {object|null} lock     設定するロック。例: `{ close: false }` または `null`
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function setPaneLock(port, termId, lock) {
  const res = await fetch(`${BASE_URL(port)}/api/set-lock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, lock }),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `set-lock failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * VK Terminals のサイドバーメニューへセクションを投稿する。
 *
 * POST /api/menu は source 単位で丸ごと置換する冪等 API のため、起動時・接続確立時・
 * ポーリングごとに何度呼んでも安全。timeoutMs は未応答ホスト（Tailscale IP 未接続等）で
 * fetch が無限にハングするのを防ぐ打ち切り時間（checkHealth と同じ理由）。
 *
 * @param {number} port VK Terminals API ポート
 * @param {object} section 投稿するメニューセクション payload
 * @param {object} [options]
 * @param {number} [options.timeoutMs=3000] fetch の打ち切り時間
 * @returns {Promise<object>} VK Terminals のレスポンス JSON
 */
export async function postMenu(port, section, { timeoutMs = 3_000 } = {}) {
  const res = await fetch(`${BASE_URL(port)}/api/menu`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(section),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok || !json?.ok) {
    throw new Error(json?.error ?? `menu post failed: HTTP ${res.status}`);
  }
  return json;
}

/**
 * 指定 termId の現在の lastOutputTime / lastLines を baseline として取得する。
 * 取得失敗時は null を返し、呼び出し側でフォールスルーさせる。
 *
 * @param {number} port    VK Terminals API ポート
 * @param {string} termId  対象ターミナルID
 * @returns {Promise<{lastOutputTime:number,lastLines:string}|null>}
 */
async function getTerminalBaseline(port, termId) {
  try {
    const { terminals } = await getStates(port);
    const term = Object.values(terminals).find(t => t.termId === termId);
    if (!term) return null;
    return {
      lastOutputTime: term.lastOutputTime ?? 0,
      lastLines:      term.lastLines ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * 送信後に baseline から出力が進んだかをポーリングで確認する。
 * timeoutMs 以内に lastOutputTime と lastLines の両方が変化すれば true を返す。
 * baseline が null（取得失敗）の場合はチェックを諦めて true を返す（誤検知防止）。
 *
 * 判定を AND にしている理由:
 *   カーソル blink などで lastOutputTime だけ進み、lastLines は変わらないケースが
 *   ある。OR 判定だとそのケースを「進んだ」と誤判定してしまうため、両方の変化を
 *   要求する AND 判定にしている。
 *
 * @param {number} port
 * @param {string} termId
 * @param {{lastOutputTime:number,lastLines:string}|null} baseline
 * @param {number} timeoutMs
 * @param {number} pollIntervalMs
 * @returns {Promise<boolean>}
 */
async function confirmOutputProgressed(port, termId, baseline, timeoutMs, pollIntervalMs) {
  if (!baseline) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    try {
      const { terminals } = await getStates(port);
      const term = Object.values(terminals).find(t => t.termId === termId);
      if (!term) {
        // ターミナルが消えた場合は呼び出し側 (waitForTerminalEvent) で検知させる
        return true;
      }
      const progressed =
        (term.lastOutputTime ?? 0) > baseline.lastOutputTime &&
        (term.lastLines ?? '')      !== baseline.lastLines;
      if (progressed) return true;
    } catch {
      // API 一時エラーはスキップしてポーリング継続
    }
  }
  return false;
}

/**
 * Claude Code の起動完了（入力受付可能）を待つ readiness ゲート。
 *
 * createNewPane 直後のペインは Claude Code の TUI が初期描画中で、入力欄（プロンプト）が
 * 現れる前に本文を送ると取りこぼし・誤入力が起こりうる（task-queue#127 の残存リスク）。
 * 特定の TUI 文字列（プロンプト記号やバージョン表記など）に依存すると Claude Code の表示
 * 変更で壊れるため、ここでは「出力が一度現れてから quietMs 以上静止したら初期描画が完了し
 * 入力待ちに入った」とみなすバージョン非依存の判定を採る。
 *
 * readyTimeoutMs を超えても静止を確認できない場合は、ブロックし続けず false を返す
 * （呼び出し側はそのまま送信を試みる＝従来挙動へフォールバックする。ファイル全体の
 * graceful degradation 方針に合わせ、ここではプロセスを落とさない）。
 *
 * @param {number} port    VK Terminals API ポート
 * @param {string} termId  対象ターミナルID
 * @param {object} [options]
 * @param {number} [options.readyTimeoutMs=45000] 静止待ちの全体タイムアウト。
 *   コールドスタートや高負荷時は起動バナーの描画（churn）が長引くため、旧既定の
 *   15 秒では静止を確認できず false に倒れて描画中の窓へ送信してしまう（task-queue#172）。
 *   churn を跨げるよう 45 秒へ広げてある（quietMs/pollIntervalMs は据え置き）。
 * @param {number} [options.quietMs=1000]         入力待ちとみなす無変化の継続時間
 * @param {number} [options.pollIntervalMs=300]   ポーリング間隔
 * @returns {Promise<boolean>} 出力出現後の静止を確認できたら true、タイムアウトなら false
 */
export async function waitForClaudeReady(port, termId, options = {}) {
  const {
    readyTimeoutMs = 45_000,
    quietMs        = 1_000,
    pollIntervalMs = 300,
  } = options;

  // 連続して termId が states に現れなかった回数。起動直後はペイン作成直後で states に
  // まだ反映されていないこと（=消失ではない）があるため、即 false にせず数回猶予する。
  const maxConsecutiveMisses = 5;

  const deadline = Date.now() + readyTimeoutMs;
  let prevSnapshot      = null;     // 直近ポーリング時の {lastOutputTime, lastLines}
  let lastChangeTime    = Date.now(); // 最後に出力が変化した時刻
  let sawOutput         = false;    // 出力が一度でも現れたか
  let consecutiveMisses = 0;        // termId が連続で見つからなかった回数

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));

    let term;
    try {
      const { terminals } = await getStates(port);
      term = Object.values(terminals).find(t => t.termId === termId);
    } catch {
      // API 一時エラーはスキップしてポーリング継続
      continue;
    }
    // termId が見つからない場合、「ペイン作成直後でまだ states に出ていない」のか
    // 「ペインが消えた」のかを 1 回では区別できない。連続で規定回数見つからなければ
    // 消失とみなして false を返し（送信側の判断に委ねる）、それ未満は猶予して継続する。
    // コールドスタート（本ゲートが守りたいケース）で states 反映が遅れても誤って
    // readiness なし送信に倒れないようにするため。
    if (!term) {
      if (++consecutiveMisses >= maxConsecutiveMisses) return false;
      continue;
    }
    consecutiveMisses = 0;

    const snapshot = {
      lastOutputTime: term.lastOutputTime ?? 0,
      lastLines:      term.lastLines ?? '',
    };
    if (snapshot.lastLines.trim() !== '') sawOutput = true;

    // 前回ポーリングから出力が変化したか（静止検知が目的なので、時刻 or 内容の
    // どちらかが変われば「未静止」とみなす OR 判定。前進検知が目的の
    // confirmOutputProgressed が AND を使うのとは目的が逆である点に注意）。
    const changed =
      prevSnapshot === null ||
      snapshot.lastOutputTime !== prevSnapshot.lastOutputTime ||
      snapshot.lastLines      !== prevSnapshot.lastLines;
    if (changed) {
      lastChangeTime = Date.now();
      prevSnapshot   = snapshot;
    }

    // 出力が現れた後 quietMs 以上静止 → 初期描画完了・入力待ちとみなす
    if (sawOutput && Date.now() - lastChangeTime >= quietMs) {
      return true;
    }
  }
  return false;
}

/**
 * 送信した本文の中から、画面エコー確認に使う「特徴的なトークン」を抽出する。
 *
 * コールドスタート時は起動バナーが本文を飲み込み、Enter だけが消費されて
 * 本文が入力欄に一切入らないことがある（task-queue のバグ再現ケース）。この
 * 取りこぼしを検知するため、Claude Code 側の UI 文字列（バージョンで変わりうる
 * バナーやプロンプト記号）ではなく「自分が送った本文そのもの」の一部が
 * `lastLines` に現れたかどうかで判定する（バージョン非依存）。
 *
 * 空白区切りのトークンのうち、末尾側から見て 4 文字以上のものを拾う。
 * 短い助詞・記号だけのトークンは端末出力（バナーやプロンプト記号など）に偶然
 * 一致しやすく、confirmBodyEchoed が誤って「エコーされた」と判定する原因になる
 * ため照合対象にしない。4 文字以上のトークンが 1 つも無い場合は null を返し、
 * エコー確認自体をスキップさせる（confirmBodyEchoed がフォールスルーで true を
 * 返す＝「判定不能なら誤検知でブロックしない」既存方針に合わせる）。実運用の
 * `/vk-kore <url> wp-env-port=NNNN` 等では十分長いトークンが必ず含まれるため
 * 実害は限定的。
 *
 * @param {string} body 送信した本文（改行除去済み）
 * @returns {string|null} 照合に使うトークン。本文が空、または 4 文字以上の
 *   トークンが無い場合は null（エコー確認自体をスキップする）
 */
function pickEchoFragment(body) {
  const trimmed = String(body).trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].length >= 4) return tokens[i];
  }
  return null;
}

/**
 * baseline（本文送信後に取得した lastLines）の中に本文のエコーが確認できるかを判定する。
 *
 * echoFragment が null（本文が空）、または baseline が null（API 一時エラーで取得失敗）の
 * 場合は判定不能として「確認できた」扱いにフォールスルーする（誤検知でブロックし続けない
 * ため。confirmOutputProgressed の baseline=null 時の扱いと同じ方針）。
 *
 * @param {{lastLines:string}|null} baseline
 * @param {string|null} echoFragment
 * @returns {boolean}
 */
function confirmBodyEchoed(baseline, echoFragment) {
  if (!echoFragment) return true;
  if (!baseline) return true;
  return baseline.lastLines.includes(echoFragment);
}

/**
 * 今この瞬間の states を取り直して、本文のエコーが画面に確認できるかを再判定する。
 *
 * submitToClaude が `bodyConfirmed:false` を返しても、エコー確認は偽陽性があり得る
 * （送信〜baseline 取得のタイミング次第でエコーを取りこぼす）。呼び出し側が
 * ロールバック（再ディスパッチ）を発動する直前に、もう一度だけエコーを確認して
 * 偽陽性で無駄な再ディスパッチをしないためのガード。判定不能時（本文が空 / 4 文字
 * 以上のトークンが無い / states 取得が API エラー）は confirmBodyEchoed と同じく
 * 「確認できた」扱い（true）にフォールスルーする。
 *
 * @param {number} port    VK Terminals API ポート
 * @param {string} termId  対象ターミナルID
 * @param {string} prompt  送信した本文（末尾の \r/\n は剥がして照合する）
 * @returns {Promise<boolean>} エコーを確認できた（または判定不能）なら true
 */
export async function reconfirmBodyEcho(port, termId, prompt) {
  const body = String(prompt).replace(/[\r\n]+$/, '');
  const echoFragment = pickEchoFragment(body);
  const baseline = await getTerminalBaseline(port, termId);
  return confirmBodyEchoed(baseline, echoFragment);
}

/**
 * Claude Code のプロンプト UI に本文を流し込んで Enter で確定させる。
 *
 * /api/send で `本文 + '\r'` を 1 リクエストで送ると、Claude Code 側が `\r` を
 * 入力欄の改行として吸収し Enter 確定にならない（入力待ちのまま止まる）。
 * 本文と Enter を別リクエストに分け、間に短い待機を入れることで確実に確定させる。
 *
 * ■ 本文エコー確認・再送（主軸）
 * コールドスタート時、起動バナーが描画中に本文を送ると本文が入力欄に届かず
 * 飲み込まれることがある。その状態で Enter を送るとバナー→プロンプトの
 * 再描画が起き、出力自体は「進んだ」ように見えてしまうため、Enter の
 * 確定確認（下記）だけでは本文欠落を検知できない（task-queue の再現バグ）。
 * これを防ぐため、本文送信後の `lastLines` に本文の一部（pickEchoFragment）が
 * 実際にエコーされたかを確認し、確認できなければ Enter だけでなく本文ごと
 * 再送する。Claude Code 側の UI 文字列（バージョンで変わりうるバナー等）には
 * 依存せず、自分が送ったテキストと照合するためバージョン非依存である。
 *
 * ■ Enter 確定確認（補助）
 * 本文エコーを確認できた後も、Enter が一度では確定されず入力欄に張り付いた
 * ままになる稀なケースに備え、Enter 送信「直前」の lastOutputTime / lastLines
 * を baseline として記録し、Enter 送信後に出力が変化しなければ Enter を
 * 再送する（本文は再送しない）。
 *
 * いずれの再送ループも規定回数まで再試行し、最後まで確認できなければ警告ログを
 * 出して return する（呼び出し側の waitForTerminalEvent が別途タイムアウト等で
 * 検知するので、ここではプロセスを落とさない）。
 *
 * baseline を「本文送信前」ではなく「本文送信後・Enter 送信前」に取るのは、
 * Claude Code が本文を受け取った瞬間に入力欄を再描画するため、本文送信前を
 * baseline にすると「Enter が効いていなくても出力は進む」状態になり、Enter が
 * 確定されていなくても progressed=true と誤判定してしまうため。
 *
 * @param {number} port           VK Terminals API ポート
 * @param {string} termId         送信先のターミナルID
 * @param {string} prompt         確定したい本文（末尾の \r/\n は剥がす）
 * @param {number} [delayMs=1000]  送信後に再描画が落ち着くまでの基準待機時間。実際の待機は
 *                                 linear backoff（delayMs × 送信回数）で伸ばし、コールドスタートの
 *                                 起動バナー描画（数秒）を跨げるようにする（task-queue#172）。
 * @param {object} [options]                  再送制御
 * @param {boolean} [options.confirm=true]    本文エコー・出力変化を確認して再送するか
 * @param {number}  [options.confirmTimeoutMs=8000]  Enter 確定確認 1 回あたりのタイムアウト
 * @param {number}  [options.pollIntervalMs=500]     確認ポーリング間隔
 * @param {number}  [options.maxRetries=3]           本文再送・Enter 再送それぞれの最大回数
 *                                                   （最初の送信と合わせて最大 maxRetries+1 回まで送信する。
 *                                                   デフォルトの 3 なら本文・Enter それぞれ計 4 回まで送る。
 *                                                   バナー churn を跨いでエコーを確認できるよう #172 で 2→3 に引き上げ）
 * @returns {Promise<object>} `/api/send`（Enter 送信）のレスポンスに `bodyConfirmed` を
 *   加えたオブジェクト（例: `{ ok: true, bodyConfirmed: true }`）。`bodyConfirmed` は
 *   本文が入力欄にエコーされたことを確認できたか:
 *     - `true`  … エコーを確認できた、またはエコー確認をスキップした
 *                 （本文が空 / 4 文字以上のトークンなし / baseline 取得が API エラー）。
 *                 「取りこぼしを検知しなかった」の意。
 *     - `false` … 本文再送を規定回数使い切ってもエコーを確認できなかった＝本文が
 *                 入力欄に届いていない可能性がある。呼び出し側で警告する材料にする。
 *     - `null`  … `confirm:false` のため確認自体を行っていない（true/false と区別する）。
 *   既存の呼び出し側は `result.ok` を見るだけなので、この追加フィールドは後方互換。
 */
export async function submitToClaude(port, termId, prompt, delayMs = 1_000, options = {}) {
  // 数値オプションを有限な非負整数に正規化するヘルパー（NaN/Infinity/負数はフォールバック）
  const toNonNegativeInt = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };

  const {
    confirm          = true,
    confirmTimeoutMs = 8_000,
    pollIntervalMs   = 500,
    maxRetries       = 3,
  } = options;

  const safeConfirmTimeoutMs = toNonNegativeInt(confirmTimeoutMs, 8_000);
  const safePollIntervalMs   = Math.max(50, toNonNegativeInt(pollIntervalMs, 500));
  const safeMaxRetries       = toNonNegativeInt(maxRetries, 3);
  // delayMs でも算術（linear backoff の乗算）を行うため、他オプション同様に健全化する。
  const safeDelayMs          = toNonNegativeInt(delayMs, 1_000);

  // 本文フェーズの待機を linear backoff（safeDelayMs × 送信回数）で伸ばす。step は
  // 初回送信後の待機を 1 回目として数え、以降 2,3,... と増やす。バナー描画が数秒かかる
  // コールドスタートでも、再送のたびに待機が伸びて描画完了を跨げるようにするため（#172）。
  let bodyWaitStep = 0;
  const waitAfterBodySend = () => new Promise(r => setTimeout(r, safeDelayMs * (++bodyWaitStep)));

  const body = String(prompt).replace(/[\r\n]+$/, '');
  const echoFragment = pickEchoFragment(body);

  // 1) 本文を送信し、入力欄の再描画が落ち着くまで待機（linear backoff の 1 回目）
  await sendToTerminal(port, termId, body);
  await waitAfterBodySend();

  if (!confirm) {
    // 従来通り、確認せず即 Enter して return（bodyConfirmed は「未確認」を表す null）
    const enterResult = await sendToTerminal(port, termId, '\r');
    return { ...enterResult, bodyConfirmed: null };
  }

  // 2) 本文が実際に入力欄へ入った（エコーされた）かを確認する。
  //    確認できるまで（規定回数を上限に）本文ごと再送する。
  //    最後に取得した baseline は、確認できてもできなくても、続く Enter 確定
  //    チェックの baseline としてそのまま流用する（Enter 送信「直前」の状態のため）。
  let baseline      = await getTerminalBaseline(port, termId);
  let bodyConfirmed = confirmBodyEchoed(baseline, echoFragment);

  for (let attempt = 0; !bodyConfirmed && attempt < safeMaxRetries; attempt++) {
    console.warn(
      `  [submitToClaude] 本文のエコーを確認できません。本文ごと再送します (termId=${termId}, attempt=${attempt + 1}/${safeMaxRetries})`
    );
    try {
      // Ctrl-A で行頭へ戻してから Ctrl-K で行末まで削除する。空欄では no-op で、追記型の入力欄でも再送を置換にできる。
      await sendToTerminal(port, termId, CLEAR_INPUT_SEQUENCE);
      await sendToTerminal(port, termId, body);
    } catch (err) {
      console.warn(`  [submitToClaude] 本文再送失敗（処理は継続）: ${err.message}`);
    }
    await waitAfterBodySend();
    baseline      = await getTerminalBaseline(port, termId);
    bodyConfirmed = confirmBodyEchoed(baseline, echoFragment);
  }

  if (!bodyConfirmed) {
    console.warn(
      `  [submitToClaude] 本文再送${safeMaxRetries}回後もエコーを確認できませんでした。Enter 送信を試みます (termId=${termId})`
    );
  }

  // 3) Enter を送信して確定
  const result = await sendToTerminal(port, termId, '\r');

  // 4) 出力変化を確認、変わらなければ Enter を再送（本文は再送しない）
  for (let attempt = 0; attempt <= safeMaxRetries; attempt++) {
    const progressed = await confirmOutputProgressed(
      port, termId, baseline, safeConfirmTimeoutMs, safePollIntervalMs
    );
    if (progressed) return { ...result, bodyConfirmed };

    if (attempt < safeMaxRetries) {
      console.warn(
        `  [submitToClaude] 出力変化なし、Enter を再送します (termId=${termId}, attempt=${attempt + 1}/${safeMaxRetries})`
      );
      try {
        await sendToTerminal(port, termId, '\r');
      } catch (err) {
        console.warn(`  [submitToClaude] Enter 再送失敗（処理は継続）: ${err.message}`);
      }
    }
  }

  console.warn(
    `  [submitToClaude] Enter 再送${safeMaxRetries}回後も出力変化を確認できませんでした (termId=${termId})`
  );
  return { ...result, bodyConfirmed };
}

/**
 * ターミナルの状態変化を監視し、以下のいずれかのイベントを返す:
 *
 * { type: 'waiting',       lastLines }  — term.waiting=true (y/n確認・権限承認など)
 * { type: 'extended-idle', lastLines }  — extendedIdleMs 以上の長時間停止
 *                                          (vk-kore が仕様提案後に止まるケースなど)
 * { type: 'idle',          lastLines }  — idleTimeoutMs のアイドル (通常完了)
 * { type: 'error',         reason    }  — ターミナルが消えた等
 *
 * @param {object} options
 * @param {number} options.idleTimeoutMs     通常完了とみなすアイドル時間 (ms)
 * @param {number} [options.extendedIdleMs]  指示待ちとみなす長時間アイドル (ms)。
 *                                           指定しない場合は検出しない。
 * @param {number} options.pollIntervalMs    ポーリング間隔 (ms)
 */
export async function waitForTerminalEvent(port, termId, options = {}) {
  const {
    idleTimeoutMs    = 10_000,
    extendedIdleMs   = null,
    pollIntervalMs   = 2_000,
  } = options;

  let lastOutputTime = Date.now();
  let lastLines      = '';
  let initialized    = false;

  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      let terminals;
      try {
        ({ terminals } = await getStates(port));
      } catch {
        // API一時エラーはスキップ
        return;
      }

      const term = Object.values(terminals).find(t => t.termId === termId);
      if (!term) {
        clearInterval(interval);
        resolve({ type: 'error', reason: 'terminal_not_found' });
        return;
      }

      // 初回: 現在の出力時刻を起点にする
      if (!initialized) {
        lastOutputTime = term.lastOutputTime ?? Date.now();
        lastLines      = term.lastLines ?? '';
        initialized    = true;
      }

      // 出力の更新を追跡
      if (term.lastOutputTime > lastOutputTime || term.lastLines !== lastLines) {
        lastOutputTime = term.lastOutputTime;
        lastLines      = term.lastLines;
      }

      // ① waiting フラグ検出（y/n確認・権限承認など）
      if (term.waiting) {
        clearInterval(interval);
        resolve({ type: 'waiting', lastLines: term.lastLines });
        return;
      }

      const idle = Date.now() - lastOutputTime;

      // ② 長時間アイドル（vk-kore が仕様確認待ちで止まるケース）
      if (extendedIdleMs !== null && idle >= extendedIdleMs) {
        clearInterval(interval);
        resolve({ type: 'extended-idle', lastLines: term.lastLines });
        return;
      }

      // ③ 通常アイドル（タスク完了）
      if (idle >= idleTimeoutMs) {
        clearInterval(interval);
        resolve({ type: 'idle', lastLines: term.lastLines });
        return;
      }
    }, pollIntervalMs);
  });
}
