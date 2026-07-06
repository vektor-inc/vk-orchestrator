/**
 * vk-terminals-tags.mjs
 *
 * vk-terminals のリモートタグ解決を共通化するヘルパー。
 * bump-vk-terminals.mjs（手動 bump）と bin/vk-orchestrator.js の up 起動時
 * 自動追従の双方から利用する。
 */

import { execFileSync } from 'child_process';

export const REPO_URL = 'https://github.com/vektor-inc/vk-terminals.git';

// リモートの全タグ → commit SHA のマップ。annotated タグは ^{} の
// dereference 済み commit を優先する（lightweight タグはそのまま）。
export function fetchTags() {
  const out = execFileSync('git', ['ls-remote', '--tags', REPO_URL], { encoding: 'utf8' });
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/);
    if (!m) continue;
    const [, sha, tag, deref] = m;
    if (deref || !map.has(tag)) map.set(tag, sha);
  }
  return map;
}

// "1.5.0" / "v1.1.0" → [1,5,0]。semver でなければ null。
export function toTuple(tag) {
  const m = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function cmpTuple(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// タグマップから最新の semver タグ文字列を返す。無ければ null。
export function latestSemverTag(tags) {
  const semver = [...tags.keys()]
    .map(t => ({ t, tup: toTuple(t) }))
    .filter(x => x.tup)
    .sort((a, b) => cmpTuple(a.tup, b.tup));
  return semver.at(-1)?.t ?? null;
}
