#!/usr/bin/env node
/**
 * 把 package.json 里的仓库三件套（repository / homepage / bugs）一次填好。
 *
 * 用法：
 *   node tools/set-repo.mjs https://github.com/<用户名>/agentdeck-super
 *   node tools/set-repo.mjs https://gitee.com/<用户名>/agentdeck-super
 *   node tools/set-repo.mjs --clear        # 清空（还没建仓库时用）
 *
 * 为什么要这一步：npm 上的 repository 字段会变成包页面上的「Repository」链接。
 * 填错或留占位符，用户点进去是 404——比不填更伤信任。所以 publish-npm.mjs 会拦。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'package.json');
const raw = process.argv[2];

if (!raw) {
  console.log('用法：node tools/set-repo.mjs <仓库地址>    例如 https://github.com/wangmian/agentdeck-super');
  console.log('      node tools/set-repo.mjs --clear      还没建仓库，先清干净');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

if (raw === '--clear') {
  delete pkg.repository;
  delete pkg.homepage;
  delete pkg.bugs;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('已清空 repository / homepage / bugs（上 npm 不受影响，只是包页面少了源码链接）');
  process.exit(0);
}

const url = raw.replace(/\.git$/, '').replace(/\/+$/, '');
if (!/^https?:\/\/[^/]+\/[^/]+\/[^/]+$/.test(url)) {
  console.error(`这不像一个仓库地址：${raw}\n要形如 https://github.com/<用户名>/<仓库名>`);
  process.exit(1);
}

pkg.repository = { type: 'git', url: `git+${url}.git` };
pkg.homepage = `${url}#readme`;
pkg.bugs = { url: `${url}/issues` };
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`已写入：\n  repository  ${pkg.repository.url}\n  homepage    ${pkg.homepage}\n  bugs        ${pkg.bugs.url}`);
console.log('\n下一步：node tools/publish-npm.mjs        （干跑体检）');
