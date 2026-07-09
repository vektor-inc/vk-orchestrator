#!/usr/bin/env node
/**
 * bump-vk-terminals.mjs
 *
 * vk-terminals 依存を指定タグ（バージョン）に更新する。
 * package.json / package-lock.json をまとめて書き換え、
 * 常に `git+https://…#<タグ>` 固定（SSH 回避）を維持する。
 *
 * 使い方:
 *   node scripts/bump-vk-terminals.mjs 1.5.1    # タグ 1.5.1 に更新
 *   node scripts/bump-vk-terminals.mjs          # リモートの最新タグに更新
 *   node scripts/bump-vk-terminals.mjs latest   # 同上
 *
 * 実行後は working tree を書き換えるだけ（commit はしない）。反映は:
 *   rm -rf node_modules/vk-terminals && npm run setup:terminals
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { fetchTags, toTuple, cmpTuple, latestSemverTag } from './vk-terminals-tags.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const arg = process.argv[2];
const tags = fetchTags();

// 更新先バージョンの決定
let version;
if (!arg || arg === 'latest') {
  version = latestSemverTag(tags);
  if (!version) {
    console.error('リモートから semver タグを解決できませんでした。');
    process.exit(1);
  }
  console.log(`最新タグを使用: ${version}`);
} else {
  version = arg.replace(/^#/, '');
}

const sha = tags.get(version);
if (!sha) {
  const known = [...tags.keys()].filter(toTuple).sort((a, b) => cmpTuple(toTuple(a), toTuple(b)));
  console.error(`タグ '${version}' が見つかりません。\n存在するタグ: ${known.join(', ')}`);
  process.exit(1);
}

const spec = `git+https://github.com/vektor-inc/vk-terminals.git#${version}`;
const resolved = `git+https://github.com/vektor-inc/vk-terminals.git#${sha}`;

// --- package.json ---
const pkgPath = join(ROOT, 'package.json');
let pkg = readFileSync(pkgPath, 'utf8');
if (!/"vk-terminals":\s*"[^"]*"/.test(pkg)) {
  console.error('package.json に vk-terminals の依存指定が見つかりません。');
  process.exit(1);
}
pkg = pkg.replace(/"vk-terminals":\s*"[^"]*"/, `"vk-terminals": "${spec}"`);
writeFileSync(pkgPath, pkg);

// --- package-lock.json ---
const lockPath = join(ROOT, 'package-lock.json');
let lock = readFileSync(lockPath, 'utf8');
// root spec（optionalDependencies。最初の "vk-terminals": は必ずここ）
lock = lock.replace(/"vk-terminals":\s*"[^"]*"/, `"vk-terminals": "${spec}"`);
// node のバージョン（"node_modules/vk-terminals" ブロック先頭の version）
lock = lock.replace(
  /("node_modules\/vk-terminals":\s*\{\s*"version":\s*")[^"]+(")/,
  `$1${version}$2`
);
// resolved（git+ssh / git+https どちらの現状からでも https へ）
lock = lock.replace(
  /("resolved":\s*")[^"]*vk-terminals\.git#[^"]+(")/,
  `$1${resolved}$2`
);
// JSON として妥当かを確認してから書き出す
JSON.parse(lock);
writeFileSync(lockPath, lock);

console.log(`\n✅ vk-terminals → ${version}（commit ${sha.slice(0, 7)}）に更新しました。`);
console.log('   package.json / package-lock.json を git+https 固定で書き換え済み。');
console.log('   CHANGELOG への追記が必要な場合はリリース工程で対応してください。');
console.log('   反映: rm -rf node_modules/vk-terminals && npm run setup:terminals');
