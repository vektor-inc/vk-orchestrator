// vk-terminals API の接続先ホスト。既定は localhost。
// vk-terminals が Tailscale IP 等の特定インターフェースだけにバインドしている場合は
// .env の VK_TERMINALS_HOST で接続先を上書きできる。
// 注意: dotenv の config() は index.js の ES import より後に走るため、ここで
// モジュール読み込み時に process.env を固定すると .env の値が間に合わない。
// 必ず「呼び出し時」に読むこと（関数化している理由）。
const apiHost = () => process.env.VK_TERMINALS_HOST ?? '127.0.0.1';
const BASE_URL = (port) => `http://${apiHost()}:${port}`;

/**
 * 自分自身が動作している vk-terminals ペインのタイトルを設定するための
 * OSC 0 エスケープシーケンス文字列を組み立てる。
 *
 * orchestrator（npm start）は自分自身の termId を知らないため、ワーカーペイン用の
 * `/api/set-title`（apiTitle）は使えない。代わりに stdout へ OSC 0/2 を書き込むと
 * vk-terminals(xterm.js) の `onTitleChange` が拾って taskTitle としてペイン上部に
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
  // eslint-disable-next-line no-control-regex
  const safe = String(title).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
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

// vk-terminals が起動しているか確認
export async function checkHealth(port) {
  try {
    const res = await fetch(`${BASE_URL(port)}/api/health`);
    const json = await res.json();
    return json.ok === true;
  } catch {
    return false;
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

// vk-terminals に新規ペインを作成して termId を返す
//   cwd を指定するとそのディレクトリで開く（未指定なら vk-terminals 側で HOME にフォールバック）。
export async function createNewPane(port, cwd = null) {
  const res = await fetch(`${BASE_URL(port)}/api/new-pane`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cwd ? { cwd } : {}),
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
// （vk-terminals 側で空文字なら非表示扱い）
/**
 * @param {string|null} [url] タスクに紐づくリンク先 URL。文字列なら body に含めて送信し、
 *   null/undefined なら body に含めない（vk-terminals 旧バージョンとの後方互換のため）。
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
 * vk-terminals issue #44 で導入された PR ボタン表示用のフィールド `apiPrUrl` に流し込む。
 * task-queue 側（orchestrator）は PR を検知した時点でこの関数を呼び、ペイン上部の
 * タスクタイトル行から PR ページへ直接ジャンプできるようにする。
 *
 * 実装メモ:
 *   vk-terminals 側は `/api/set-title` の `prUrl` フィールドで受け取る仕様で、
 *   `title` / `url` / `prUrl` の 3 つをペアで置換するセマンティクスを持つ。
 *   そのため prUrl だけ単独更新するには、先に getStates で現在の apiTitle / apiUrl を
 *   取得してから一緒に送り直す必要がある。
 *
 *   呼び出し側 (recordPRAcrossSurfaces) は失敗を warn で握りつぶす運用なので、
 *   状態取得などの途中失敗は throw して上に伝える。
 *
 * @param {number} port           vk-terminals API ポート
 * @param {string|number} termId  対象ターミナル ID
 * @param {string|null} prUrl     PR の HTML URL（クリアしたい場合は空文字）
 */
export async function setTerminalPrUrl(port, termId, prUrl) {
  const { terminals } = await getStates(port);
  // /api/states のレスポンス形が想定外（terminals 欠落・非オブジェクト）だと
  // Object.values(undefined) で TypeError になり原因が追いづらいため、
  // 明示的に検証して原因が分かるエラーメッセージを返す。
  if (!terminals || typeof terminals !== 'object') {
    throw new Error(`invalid states response from vk-terminals (port=${port}): terminals missing`);
  }
  const term = Object.values(terminals).find(t => String(t.termId) === String(termId));
  if (!term) {
    throw new Error(`terminal ${termId} not found`);
  }
  const payload = {
    termId,
    title: term.apiTitle ?? '',
    url:   term.apiUrl   ?? '',
    prUrl: prUrl ?? '',
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
 * 指定 termId の現在の lastOutputTime / lastLines を baseline として取得する。
 * 取得失敗時は null を返し、呼び出し側でフォールスルーさせる。
 *
 * @param {number} port    vk-terminals API ポート
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
 * @param {number} port    vk-terminals API ポート
 * @param {string} termId  対象ターミナルID
 * @param {object} [options]
 * @param {number} [options.readyTimeoutMs=15000] 静止待ちの全体タイムアウト
 * @param {number} [options.quietMs=1000]         入力待ちとみなす無変化の継続時間
 * @param {number} [options.pollIntervalMs=300]   ポーリング間隔
 * @returns {Promise<boolean>} 出力出現後の静止を確認できたら true、タイムアウトなら false
 */
export async function waitForClaudeReady(port, termId, options = {}) {
  const {
    readyTimeoutMs = 15_000,
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
 * Claude Code のプロンプト UI に本文を流し込んで Enter で確定させる。
 *
 * /api/send で `本文 + '\r'` を 1 リクエストで送ると、Claude Code 側が `\r` を
 * 入力欄の改行として吸収し Enter 確定にならない（入力待ちのまま止まる）。
 * 本文と Enter を別リクエストに分け、間に短い待機を入れることで確実に確定させる。
 *
 * さらに、Enter が一度では確定されず入力欄に張り付いたままになる稀なケースに備え、
 * Enter 送信「直前」の lastOutputTime / lastLines を baseline として記録し、Enter
 * 送信後に出力が変化しなければ Enter を再送する。規定回数まで再試行し、最後まで
 * 変化が確認できなければ警告ログを出して return する（呼び出し側の
 * waitForTerminalEvent が別途タイムアウト等で検知するので、ここではプロセスを
 * 落とさない）。
 *
 * baseline を「本文送信前」ではなく「本文送信後・Enter 送信前」に取るのは、
 * Claude Code が本文を受け取った瞬間に入力欄を再描画するため、本文送信前を
 * baseline にすると「Enter が効いていなくても出力は進む」状態になり、Enter が
 * 確定されていなくても progressed=true と誤判定してしまうため。
 *
 * @param {number} port           vk-terminals API ポート
 * @param {string} termId         送信先のターミナルID
 * @param {string} prompt         確定したい本文（末尾の \r/\n は剥がす）
 * @param {number} [delayMs=500]  本文送信後 Enter までの待機時間（baseline はこの待機の後に取得する）
 * @param {object} [options]                  Enter 再送制御
 * @param {boolean} [options.confirm=true]    出力変化を確認して再送するか
 * @param {number}  [options.confirmTimeoutMs=8000]  1 回あたりの確認タイムアウト
 * @param {number}  [options.pollIntervalMs=500]     確認ポーリング間隔
 * @param {number}  [options.maxRetries=2]           Enter 再送の最大回数
 *                                                   （最初の Enter と合わせて最大 maxRetries+1 回送信する。
 *                                                   デフォルトの 2 なら計 3 回まで Enter を打つ）
 */
export async function submitToClaude(port, termId, prompt, delayMs = 500, options = {}) {
  // 数値オプションを有限な非負整数に正規化するヘルパー（NaN/Infinity/負数はフォールバック）
  const toNonNegativeInt = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };

  const {
    confirm          = true,
    confirmTimeoutMs = 8_000,
    pollIntervalMs   = 500,
    maxRetries       = 2,
  } = options;

  const safeConfirmTimeoutMs = toNonNegativeInt(confirmTimeoutMs, 8_000);
  const safePollIntervalMs   = Math.max(50, toNonNegativeInt(pollIntervalMs, 500));
  const safeMaxRetries       = toNonNegativeInt(maxRetries, 2);

  const body = String(prompt).replace(/[\r\n]+$/, '');

  // 1) 本文を送信し、入力欄の再描画が落ち着くまで待機
  await sendToTerminal(port, termId, body);
  await new Promise(r => setTimeout(r, delayMs));

  // 2) Enter 送信「直前」の baseline を記録する（API エラー時は null でフォールスルー）。
  //    本文受信後の入力欄再描画はこの時点までに反映されているはずなので、
  //    以降の出力変化は Enter による確定後のものとみなせる。
  const baseline = confirm ? await getTerminalBaseline(port, termId) : null;

  // 3) Enter を送信して確定
  const result = await sendToTerminal(port, termId, '\r');

  if (!confirm) return result;

  // 4) 出力変化を確認、変わらなければ Enter を再送
  for (let attempt = 0; attempt <= safeMaxRetries; attempt++) {
    const progressed = await confirmOutputProgressed(
      port, termId, baseline, safeConfirmTimeoutMs, safePollIntervalMs
    );
    if (progressed) return result;

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
  return result;
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
