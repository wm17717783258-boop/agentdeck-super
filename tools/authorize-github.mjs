#!/usr/bin/env node
/**
 * tools/authorize-github.mjs — 用「设备码」拿一个 GitHub 令牌（不用装 git / gh）
 *
 * 流程（全程只要求你在浏览器里点一次 Authorize，因为令牌只能由账号本人生成）：
 *   1. 本脚本向 GitHub 申请一个 8 位设备码，打印出 https://github.com/login/device 和码
 *   2. 你在浏览器里粘贴这个码 → 点 Authorize
 *   3. 脚本每 5 秒轮询一次，拿到 token 后写进 `.secrets/gh.token`（.gitignore 已忽略）
 *
 * 用法：
 *   node tools/authorize-github.mjs            # 拿令牌并保存
 *   node tools/authorize-github.mjs --status   # 看现在有没有可用的令牌
 *
 * 拿到后：`node tools/publish-repo.mjs --push` 会自动读这个文件（也可用 GITHUB_TOKEN 覆盖）。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tokenPath = join(root, '.secrets', 'gh.token');
const CLIENT_ID = process.env.AGENTDECK_GH_CLIENT_ID || '178c6fc778ccc68e1d6a'; // gh CLI 的公开 client id
const SCOPES = ['repo', 'read:user'];

const log = (s = '') => console.log(s);

if (process.argv.includes('--status')) {
  const t = process.env.GITHUB_TOKEN || (existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : '');
  log(t ? `有令牌（${t.slice(0, 4)}…${t.slice(-4)}，${t.length} 字符，来源：${process.env.GITHUB_TOKEN ? '环境变量' : tokenPath}）` : '还没有令牌');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(`https://github.com${path}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

log('向 GitHub 申请设备码…');
const start = await post('/login/device/code', { client_id: CLIENT_ID, scope: SCOPES.join(' ') });
if (start.status !== 200 || !start.json.device_code) {
  console.error('申请失败：', JSON.stringify(start.json).slice(0, 400));
  console.error('（如果提示 device flow 不支持，就改用 classic token：GitHub → Settings → Developer settings → Tokens (classic) → 勾 repo）');
  process.exit(1);
}

const { device_code, user_code, verification_uri, interval, expires_in } = start.json;
log('');
log('  在浏览器打开：' + verification_uri);
log('  粘贴这个码：  ' + user_code);
log('');
log(`  （${Math.round(expires_in / 60)} 分钟内有效；页面里点 Authorize 就行，只有一个按钮）`);
log('  等待授权…');

const waitMs = Math.max(5, Number(interval) || 5) * 1000;
const deadline = Date.now() + expires_in * 1000;
let token = '';
while (Date.now() < deadline) {
  await sleep(waitMs);
  const poll = await post('/login/oauth/access_token', {
    client_id: CLIENT_ID,
    device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  const j = poll.json || {};
  if (j.access_token) {
    token = j.access_token;
    break;
  }
  if (j.error === 'authorization_pending') continue;
  if (j.error === 'slow_down') {
    await sleep(waitMs);
    continue;
  }
  console.error('\n授权失败：', j.error, j.error_description || '');
  process.exit(1);
}

if (!token) {
  console.error('\n超时了，没拿到授权。重跑一次本脚本即可。');
  process.exit(1);
}

mkdirSync(dirname(tokenPath), { recursive: true });
writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 });
log('');
log(`✓ 授权成功，令牌已保存到 ${tokenPath}（.gitignore 已忽略，别提交）`);
log('下一步：node tools/publish-repo.mjs --push');
