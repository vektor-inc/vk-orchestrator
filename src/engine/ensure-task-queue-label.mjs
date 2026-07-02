/**
 * ensure-task-queue-label.mjs
 *
 * vektor-inc org の各リポジトリに `task-queue` ラベルが存在することを保証する。
 *
 * 背景:
 *   orchestrator は GitHub Search API で `label:task-queue` を組織横断検索して
 *   取り込み対象 issue を見つける（github.js の searchSourceIssuesByLabel）。
 *   ラベルは GitHub の issue 画面から都度作れるが、各リポジトリに事前に作っておくと
 *   依頼者がラベル名のタイプミスや未作成で詰まらない。新規リポジトリ追加時に流すと便利。
 *
 * 実行:
 *   node ensure-task-queue-label.mjs                # org の全リポジトリを対象
 *   node ensure-task-queue-label.mjs repo1 repo2    # 指定リポジトリのみ
 *   node ensure-task-queue-label.mjs --list         # 対象リポジトリ一覧を表示するだけ
 *
 * 認証:
 *   gh CLI（`gh auth login` 済み）を利用する。org の private repo にもアクセスする必要が
 *   ある場合は、SETUP_TOKEN 環境変数に classic PAT（`repo` スコープ）を渡す:
 *     SETUP_TOKEN=ghp_xxx node ensure-task-queue-label.mjs
 */

import { execFileSync } from 'child_process';

const OWNER     = process.env.GITHUB_OWNER ?? 'vektor-inc';
const TASK_REPO = process.env.GITHUB_REPO  ?? 'task-queue';

const SETUP_TOKEN = process.env.SETUP_TOKEN || null;

// GitHub の owner / repo 名で使える文字（英数字・ピリオド・ハイフン・アンダースコア）。
// execFile 経由で渡すためシェルインジェクションは原理上発生しないが、API パスに埋め込むので念のため検証する。
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
function assertSafeName(label, value) {
  if (!NAME_PATTERN.test(value)) {
    throw new Error(`不正な ${label} 名: "${value}"（英数字・. - _ のみ許可）`);
  }
}
assertSafeName('GITHUB_OWNER', OWNER);
assertSafeName('GITHUB_REPO', TASK_REPO);

if (!SETUP_TOKEN) {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    console.error('gh CLI が認証されていません。`gh auth login` を実行するか、SETUP_TOKEN=ghp_xxx を指定してください。');
    process.exit(1);
  }
}

// gh CLI をシェル経由せず execFile で呼び出す（コマンドインジェクション対策）。
// 引数は配列で受け取り、テンプレートリテラル展開を一切しない。
function gh(argv) {
  const env = SETUP_TOKEN
    ? { ...process.env, GH_TOKEN: SETUP_TOKEN }
    : process.env;
  return execFileSync('gh', argv, { encoding: 'utf8', stdio: 'pipe', env });
}
function ghJSON(argv) {
  const out = gh(argv);
  try {
    return JSON.parse(out);
  } catch (err) {
    console.error(`gh ${argv.join(' ')} の出力を JSON としてパースできませんでした:\n${out}`);
    throw err;
  }
}

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const targetRepos = args.filter(a => !a.startsWith('--'));

function fetchOrgRepos() {
  const repos = ghJSON(['api', `/orgs/${OWNER}/repos?type=all&per_page=100`]);
  return repos.filter(r => !r.fork && r.name !== TASK_REPO);
}

function ensureLabel(repo) {
  assertSafeName('repository', repo);
  try {
    ghJSON(['api', `/repos/${OWNER}/${repo}/labels/task-queue`]);
    console.log(`    ✔ label 'task-queue' 既存`);
    return;
  } catch (err) {
    // 404（ラベル未存在）だけ「作成」分岐に入れ、それ以外（権限不足・ネットワーク等）は上位へ。
    const stderr = err.stderr?.toString() ?? '';
    if (!/HTTP 404/.test(stderr)) throw err;
  }
  gh([
    'api', '--method', 'POST',
    `/repos/${OWNER}/${repo}/labels`,
    '-f', 'name=task-queue',
    '-f', 'color=0075ca',
    '-f', 'description=task-queue に自動登録',
  ]);
  console.log(`    ✅ label 'task-queue' 作成`);
}

function main() {
  console.log(`=== task-queue ラベル ensure (org: ${OWNER}) ===\n`);

  let repos;
  if (targetRepos.length > 0) {
    repos = targetRepos.map(name => ({ name }));
  } else {
    console.log('org のリポジトリを取得中...');
    repos = fetchOrgRepos();
    console.log(`  → ${repos.length} 件\n`);
  }

  if (listOnly) {
    console.log('対象リポジトリ一覧:');
    repos.forEach(r => console.log(`  - ${r.name}`));
    return;
  }

  let ok = 0, ng = 0;
  for (const r of repos) {
    console.log(`[${r.name}]`);
    try {
      ensureLabel(r.name);
      ok++;
    } catch (err) {
      const msg = err.stderr?.toString().trim() || err.message;
      console.error(`    ❌ エラー: ${msg}`);
      ng++;
    }
  }

  console.log(`\n完了: ${ok} 件成功、${ng} 件失敗`);
}

main();
