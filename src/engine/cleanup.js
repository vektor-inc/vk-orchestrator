// scanWatchdog（pane 消失検知）から呼ばれるクリーンアップ処理。
// 残った wp-env コンテナを destroy し、worktree を削除する（ブランチは残す）。
import { promisify } from 'util';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';

const exec = promisify(execFile);

async function run(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      maxBuffer: 10 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      message: err.message,
    };
  }
}

// 指定ポートを公開している docker コンテナを返す
async function findContainersByPort(port) {
  const result = await run('docker', [
    'ps', '-a',
    '--filter', `publish=${port}`,
    '--format', '{{.ID}}\t{{.Names}}\t{{.Labels}}',
  ]);
  if (!result.ok || !result.stdout.trim()) return [];

  return result.stdout.trim().split('\n').map(line => {
    const [id, name, labels] = line.split('\t');
    // labels は "key=val,key=val,..." 形式
    const labelMap = {};
    if (labels) {
      for (const pair of labels.split(',')) {
        const eq = pair.indexOf('=');
        if (eq > 0) labelMap[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
    return { id, name, labels: labelMap };
  });
}

// 同じ compose プロジェクト名のコンテナを全部集める（tests-* や mysql-* も含めるため）
async function findContainersByProject(projectName) {
  const result = await run('docker', [
    'ps', '-a',
    '--filter', `label=com.docker.compose.project=${projectName}`,
    '--format', '{{.ID}}',
  ]);
  if (!result.ok || !result.stdout.trim()) return [];
  return result.stdout.trim().split('\n');
}

// 同じ compose プロジェクト名のボリュームを集める
async function findVolumesByProject(projectName) {
  const result = await run('docker', [
    'volume', 'ls',
    '--filter', `label=com.docker.compose.project=${projectName}`,
    '-q',
  ]);
  if (!result.ok || !result.stdout.trim()) return [];
  return result.stdout.trim().split('\n');
}

// 同じ compose プロジェクト名のネットワークを集める
async function findNetworksByProject(projectName) {
  const result = await run('docker', [
    'network', 'ls',
    '--filter', `label=com.docker.compose.project=${projectName}`,
    '-q',
  ]);
  if (!result.ok || !result.stdout.trim()) return [];
  return result.stdout.trim().split('\n');
}

// パスが既存ディレクトリか
async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// worktree パスから所属リポジトリのルートを推測する。
// Agent の isolation: "worktree" は <repo>/.claude/worktrees/<name> に作られるので、
// `.claude/worktrees/` を切り出して親ディレクトリをリポジトリとみなす。
function inferRepoRootFromWorktree(worktreePath) {
  const marker = '/.claude/worktrees/';
  const idx = worktreePath.indexOf(marker);
  if (idx === -1) return null;
  return worktreePath.slice(0, idx);
}

/**
 * wpPort で動いている wp-env コンテナのラベルから worktree パスを取得する。
 * コンテナが生存している間に呼び、結果を state.json に snapshot しておくことで、
 * automerge 発火時にコンテナが destroy 済みでも cleanupForIssue が worktree を掃除できる。
 * コンテナが見つからなければ null を返す（致命ではない）。
 */
export async function inspectWorktreeByPort(wpPort) {
  if (!wpPort) return null;
  const containers = await findContainersByPort(wpPort);
  if (containers.length === 0) return null;
  const labels = containers[0].labels;
  const worktreePath = labels['com.docker.compose.project.working_dir'] ?? null;
  if (!worktreePath) return null;
  return { worktreePath };
}

/**
 * 指定 issue のリカバリー／マージ後に呼ぶクリーンアップ。
 * - 既知の wpPort からコンテナ群を特定
 * - working_dir ラベルから worktree パスを取得
 * - compose プロジェクト単位でコンテナ・ボリューム・ネットワークを削除（destroy 相当）
 * - worktree ディレクトリを削除
 * - branch が渡された場合は worktree 削除後にマージ済みローカルブランチも削除（vk-clean-repo 相当）
 *
 * branch を渡さない pane 消失リカバリー時はブランチを残す（未マージの可能性があるため）。
 * automerge / 外部マージ後は branch（PR head ref）を渡してブランチまで掃除する。
 *
 * 部分失敗してもエラーは投げず、ログだけ残す（次のステップ＝status:ready 戻し／done 遷移は続行させたい）。
 * 返り値: クリーンアップ内容のサマリ（GitHub コメント用）
 */
export async function cleanupForIssue({ issueNumber, wpPort, branch = null, worktreePath = null }) {
  const summary = {
    wpPort,
    containers: [],
    worktreePath: null,
    containersRemoved: 0,
    volumesRemoved: 0,
    networksRemoved: 0,
    worktreeRemoved: false,
    branch,
    branchRemoved: false,
    notes: [],
  };

  // 1. ポートからコンテナを特定（生存していれば docker リソースを destroy する）
  const containers = wpPort ? await findContainersByPort(wpPort) : [];
  summary.containers = containers.map(c => c.name);

  // 2. worktree パスと compose プロジェクト名を決定する。
  //    生存コンテナのラベルを最優先し、無ければ state.json に記録された
  //    worktreePath（コンテナ生存中に snapshot した値）をフォールバックに使う。
  //    これにより automerge 発火時に wp-env が既に destroy 済みでも
  //    worktree・ブランチを掃除できる。
  let workingDir  = null;
  let projectName = null;
  if (containers.length > 0) {
    const head = containers[0];
    workingDir  = head.labels['com.docker.compose.project.working_dir'] ?? null;
    projectName = head.labels['com.docker.compose.project'] ?? null;
  }
  if (!workingDir && worktreePath) {
    workingDir = worktreePath;
    summary.notes.push('生存コンテナが無いため記録済み worktree パスで掃除');
  }
  summary.worktreePath = workingDir;

  if (!wpPort && !workingDir) {
    summary.notes.push('wpPort も worktree パスも未記録のため掃除対象を特定できず');
    return summary;
  }

  // 3. compose プロジェクト単位で削除（destroy 相当：コンテナ＋ボリューム＋ネットワーク）。
  //    コンテナが生存していないときは docker 掃除はスキップし、worktree/branch 掃除へ進む。
  if (containers.length === 0) {
    summary.notes.push(wpPort ? `ポート ${wpPort} を使うコンテナなし（docker 掃除はスキップ）` : 'wpPort 未記録のため docker 掃除はスキップ');
  } else if (projectName) {
    // 3-1. コンテナを停止して削除
    const containerIds = await findContainersByProject(projectName);
    if (containerIds.length > 0) {
      console.log(`  [cleanup #${issueNumber}] docker rm -f ${containerIds.length} containers (project=${projectName})`);
      const rmResult = await run('docker', ['rm', '-f', ...containerIds]);
      if (rmResult.ok) {
        summary.containersRemoved = containerIds.length;
      } else {
        summary.notes.push(`docker rm 失敗: ${rmResult.message?.split('\n')[0] ?? 'unknown'}`);
      }
    }

    // 3-2. ボリュームを削除
    const volumeIds = await findVolumesByProject(projectName);
    if (volumeIds.length > 0) {
      console.log(`  [cleanup #${issueNumber}] docker volume rm ${volumeIds.length} volumes`);
      const rmResult = await run('docker', ['volume', 'rm', ...volumeIds]);
      if (rmResult.ok) {
        summary.volumesRemoved = volumeIds.length;
      } else {
        summary.notes.push(`docker volume rm 失敗: ${rmResult.message?.split('\n')[0] ?? 'unknown'}`);
      }
    }

    // 3-3. ネットワークを削除
    const networkIds = await findNetworksByProject(projectName);
    if (networkIds.length > 0) {
      console.log(`  [cleanup #${issueNumber}] docker network rm ${networkIds.length} networks`);
      const rmResult = await run('docker', ['network', 'rm', ...networkIds]);
      if (rmResult.ok) {
        summary.networksRemoved = networkIds.length;
      } else {
        summary.notes.push(`docker network rm 失敗: ${rmResult.message?.split('\n')[0] ?? 'unknown'}`);
      }
    }
  } else {
    // プロジェクト名が取れなかった場合はポートで特定したコンテナだけを消す（ボリュームは消えない）
    summary.notes.push('compose プロジェクト名が取得できずコンテナのみ削除');
    const ids = containers.map(c => c.id);
    const rmResult = await run('docker', ['rm', '-f', ...ids]);
    if (rmResult.ok) summary.containersRemoved = ids.length;
  }

  // 4. worktree 削除
  let repoRoot = null;
  if (workingDir) {
    repoRoot = inferRepoRootFromWorktree(workingDir);
    if (repoRoot && await pathExists(repoRoot)) {
      console.log(`  [cleanup #${issueNumber}] git worktree remove --force ${workingDir}`);
      const rmResult = await run('git', ['worktree', 'remove', '--force', workingDir], { cwd: repoRoot });
      if (rmResult.ok) {
        summary.worktreeRemoved = true;
      } else {
        // git worktree が認識していないケース。ディレクトリだけ残っているなら rm -rf する
        if (await pathExists(workingDir)) {
          await fs.rm(workingDir, { recursive: true, force: true }).catch(err => {
            summary.notes.push(`worktree ディレクトリ削除失敗: ${err.message}`);
          });
          // prune で .git/worktrees からも消す
          await run('git', ['worktree', 'prune'], { cwd: repoRoot });
          summary.worktreeRemoved = !(await pathExists(workingDir));
        } else {
          summary.worktreeRemoved = true;
        }
      }
    } else {
      summary.notes.push(`リポジトリルートが推測できず worktree 削除スキップ: ${workingDir}`);
    }
  }

  // 5. マージ済みローカルブランチの削除（branch 指定時のみ。vk-clean-repo 相当）
  //    worktree 削除後に実行する（チェックアウト中のブランチは削除できないため）。
  //    squash merge では git 上は未マージ扱いになるため -D で強制削除する。
  if (branch) {
    if (repoRoot && await pathExists(repoRoot)) {
      // worktree が残っているとブランチ削除に失敗するので prune してから消す
      await run('git', ['worktree', 'prune'], { cwd: repoRoot });
      const exists = await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot });
      if (!exists.ok) {
        // ローカルにブランチが無い（既に削除済み／別マシンで作業）→ 何もしない
        summary.branchRemoved = true;
        summary.notes.push(`ローカルブランチ ${branch} は存在せず`);
      } else {
        console.log(`  [cleanup #${issueNumber}] git branch -D ${branch}`);
        const delResult = await run('git', ['branch', '-D', branch], { cwd: repoRoot });
        if (delResult.ok) {
          summary.branchRemoved = true;
        } else {
          summary.notes.push(`ブランチ削除失敗 (${branch}): ${delResult.message?.split('\n')[0] ?? 'unknown'}`);
        }
      }
    } else {
      summary.notes.push(`リポジトリルートが特定できずブランチ削除スキップ: ${branch}`);
    }
  }

  return summary;
}

// GitHub コメント用に整形
export function formatCleanupSummary(summary) {
  const lines = [];
  lines.push(`- wp-env ポート: \`${summary.wpPort ?? '不明'}\``);
  if (summary.worktreePath) {
    lines.push(`- worktree: \`${summary.worktreePath}\` ${summary.worktreeRemoved ? '→ 削除' : '→ 残存'}`);
  }
  if (summary.branch) {
    lines.push(`- ブランチ: \`${summary.branch}\` ${summary.branchRemoved ? '→ 削除' : '→ 残存'}`);
  }
  if (summary.containers.length > 0) {
    lines.push(`- 検出コンテナ: ${summary.containers.length} 個 → \`docker rm\` ${summary.containersRemoved} 件 / ボリューム ${summary.volumesRemoved} 件 / ネットワーク ${summary.networksRemoved} 件`);
  }
  if (summary.notes.length > 0) {
    lines.push(`- 備考: ${summary.notes.join(' / ')}`);
  }
  return lines.join('\n');
}
