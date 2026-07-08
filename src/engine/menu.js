// VK Terminals へ注入するサイドバーメニューの payload 組み立てをここに集約する。
// HTTP 送信は terminals/index.js の postMenu に委譲し、このファイルは副作用のない純粋関数だけにする。
// 将来、実行中タスク一覧などの動的メニューを追加するときも、組み立てと送信を分けたまま拡張できる。

// POST /api/menu は source 単位でセクション全体を丸ごと置換するため、この識別子を固定して使う。
export const MENU_SOURCE = 'vk-orchestrator';

/**
 * task-queue の issue 一覧 URL を組み立てる。
 *
 * @param {string} owner GitHub リポジトリ owner
 * @param {string} repo GitHub リポジトリ名
 * @returns {string} task-queue の issue 一覧 URL
 */
export function taskQueueIssuesUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}/issues`;
}

/**
 * VK Terminals のサイドバーメニューへ投入する VK Orchestrator セクションを組み立てる。
 *
 * 初期項目は task-queue の issue 一覧を開く項目。owner/repo はタスク登録リポジトリ
 * （task-queue。既定 vektor-inc/task-queue）から解決する。POST /api/menu は同じ source の再投稿で
 * セクション全体を置換するため、ここでは常に完全なセクション payload を返す。
 *
 * @param {object} params
 * @param {string} params.owner GitHub リポジトリ owner
 * @param {string} params.repo GitHub リポジトリ名
 * @returns {{source:string,title:string,items:Array<{id:string,label:string,icon:string,action:{type:string,url:string}}>} VK Terminals menu section
 */
export function buildOrchestratorMenu({ owner, repo }) {
  return {
    source: MENU_SOURCE,
    title: 'VK Orchestrator',
    items: [
      {
        id: 'task-queue',
        label: 'task-queue',
        icon: '📋',
        action: { type: 'open-url', url: taskQueueIssuesUrl(owner, repo) },
      },
    ],
  };
}
