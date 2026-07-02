import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '..', '.env') });

import { GitHubClient } from '../github/index.js';

const GITHUB_OWNER = process.env.GITHUB_OWNER ?? 'vektor-inc';
const GITHUB_REPO  = process.env.GITHUB_REPO  ?? 'task-queue';
const github = new GitHubClient({ token: process.env.GITHUB_TOKEN, owner: GITHUB_OWNER, repo: GITHUB_REPO });

const { data: issues } = await github.octokit.issues.listForRepo({
  owner: GITHUB_OWNER, repo: GITHUB_REPO, state: 'open',
  labels: 'status:waiting-input', per_page: 50,
});

if (issues.length === 0) {
  console.log('waiting-input なissueはありません');
  process.exit(0);
}

console.log(`waiting-input issue が ${issues.length} 件あります。status:ready にリセットします。\n`);

for (const issue of issues) {
  console.log(`  → #${issue.number} "${issue.title}"`);
  await github.setStatus(issue.number, 'status:ready');
  await github.addComment(issue.number,
    `🔄 waiting-input 誤検知のためリセット。\`status:ready\` に戻しました。オーケストレーター再実行で再処理されます。`
  );
}

console.log('\n完了。orchestrator を --once で再実行してください。');
