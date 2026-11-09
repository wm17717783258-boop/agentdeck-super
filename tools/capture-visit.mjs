#!/usr/bin/env node
/**
 * 串门 + 皮肤的真实往返记录（用于 docs/evidence/pet-visit-1.6.4.txt）
 *
 * 做法：起两个**互相独立**的 Hub（各自的 workspace / 任务板 / 桌宠档案 / 授权目录），
 * 让「小犀」（A）和「小鹿」（B）真的走一遍：名片 → 邀请 → 收邀请 → 送礼 → 收礼 → 求助 → 落任务 → 串门记录，
 * 再把皮肤列表 / 换装 / 四种状态渲染跑一遍。全程只调公开工具面（和用户在会话里让 Agent 调的是同一套）。
 *
 * 用法：node tools/capture-visit.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../lib/hub.js';
import { createProfileStore } from '../lib/pet/profile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const DEMO = process.env.NEXI_VISIT_ROOT || mkdtempSync(join(tmpdir(), 'nexi-visit-'));
const ownedDemo = !process.env.NEXI_VISIT_ROOT;
const OUT = join(PKG, 'docs', 'evidence', 'pet-visit-1.6.4.txt');
const LICENSE_SRC = process.env.NEXI_LICENSE_KEY || '';

const lines = [];
function say(text = '') {
  lines.push(text);
  console.log(text);
}

function clean(dir) {
  if (dir === DEMO || !dir.startsWith(DEMO)) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function textOf(blocks) {
  return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
}

function mkProfile(root, name) {
  mkdirSync(join(root, '.agentdeck', 'pet'), { recursive: true });
  const store = createProfileStore({ root });
  store.update((draft) => { draft.name = name; });
  return store;
}

function copyLicense(root) {
  try {
    if (!existsSync(LICENSE_SRC)) return false;
    const dir = join(root, '.agentdeck', 'license');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'key.txt'), readFileSync(LICENSE_SRC), 'utf8');
    return true;
  } catch { return false; }
}

async function mkHub(tag, name, { license = true } = {}) {
  const base = join(DEMO, tag);
  clean(base);
  const workspace = join(base, 'work');
  mkdirSync(workspace, { recursive: true });
  const root = workspace;
  mkProfile(root, name);
  const licenseRoot = join(base, 'lic');
  const hasLicense = license ? copyLicense(licenseRoot) : false;
  const hub = await createHub({
    workspace,
    boardRoot: join(base, 'board'),
    petRoot: root,
    licenseRoot,
    config: { petRoot: root, licenseRoot },
    onLog: () => {},
  });
  return { hub, base, root, name, hasLicense };
}

const A = await mkHub('hostA', '小犀');
const B = await mkHub('hostB', '小鹿');

say('# 桌宠串门 + 皮肤：两台互不相干的 Hub 真往返（1.6.4）');
say('');
say(`- 时间：${new Date().toISOString()}`);
say(`- 版本：agentdeck-super@${JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version}`);
say(`- 小犀（A）：工作区 ${join(A.base, 'work')}，任务板 ${join(A.base, 'board')}，授权：${A.hasLicense ? '本机工作室版' : '无（免费版）'}`);
say(`- 小鹿（B）：工作区 ${join(B.base, 'work')}，任务板 ${join(B.base, 'board')}，授权：${B.hasLicense ? '本机工作室版' : '无（免费版）'}`);
say('- 说明：两个 Hub 各自一份任务板 / 桌宠档案 / 授权目录，除了显式传过去的邀请函和便签 JSON，互相看不见对方的东西。');
say('');

// 1. 名片
say('## 1) 小犀亮名片（只给名片，不给原始记录）');
say('```text');
say(textOf(await A.hub.call('pet_visit', { action: 'card' })));
say('```');
say('');

// 2. 建组（后面求助便签要落到组里）
const teamRes = textOf(await A.hub.call('team_board', { action: 'create', name: '串门演示', goal: '验证串门与求助便签能落成任务', members: ['小犀'] }));
say('## 2) 小犀先建一个组（求助便签要落到这个组）');
say('```text');
say(teamRes);
say('```');
const teamId = (teamRes.match(/team_[0-9a-f]{6,}/i) || [])[0] || '';
say('');

// 3. 邀请
say('## 3) 小犀发邀请函（scope=work，24 小时有效）');
const inviteText = textOf(await A.hub.call('pet_visit', { action: 'invite', scope: 'work', ttlHours: 24 }));
const token = (inviteText.match(/[?&]t=([A-Za-z0-9._~-]+)/) || [])[1] || '';
const inviteShown = token ? inviteText.replaceAll(token, `<邀请令牌已脱敏，长度 ${token.length}>`) : inviteText;
say('```text');
say(inviteShown);
say('```');
say(`- 取到 token：${token ? `已脱敏（${token.length} 字符，未写入证据）` : '没取到'}`);
say('');

// 4. 收邀请
say('## 4) 小鹿收下邀请（校验签名 / 有效期 / 范围）');
say('```text');
say(textOf(await B.hub.call('pet_visit', { action: 'accept', token, expectedScope: 'work' })));
say('```');
say('');

// 4b. 小鹿也建一个组（收礼便签要求本地有组）
const teamBRes = textOf(await B.hub.call('team_board', { action: 'create', name: '小鹿的组', members: ['小鹿'] }));
const teamB = (teamBRes.match(/team_[0-9a-f]{6,}/i) || [])[0] || '';
say('## 5) 小鹿建自己的组（收便签用）');
say('```text');
say(teamBRes);
say('```');
say('');

// 5. 送礼
const giftText = textOf(await A.hub.call('pet_visit', { action: 'gift', to: '小鹿', skin: 'premium-aurora', message: '这套极光皮肤送你，夜里写代码好看' }));
say('## 6) 小犀送出一张礼物便签（含一套付费皮肤）');
say('```text');
say(giftText);
say('```');
const giftJson = (giftText.match(/```json\n([\s\S]*?)```/) || [])[1] || '';
say('');

// 6. 收礼
say('## 7) 小鹿收下礼物');
say('```text');
say(textOf(await B.hub.call('pet_visit', { action: 'receive', note: giftJson })));
say('```');
say('');

// 7. 求助
const askText = textOf(await B.hub.call('pet_visit', { action: 'ask', to: '小犀', title: '帮我把周报 SQL 里的时间窗改成按自然周', acceptance: '给出改完的 SQL 和一句为什么', role: 'worker' }));
say('## 8) 小鹿回一张求助便签');
say('```text');
say(askText);
say('```');
const askJson = (askText.match(/```json\n([\s\S]*?)```/) || [])[1] || '';
say('');

// 8. 收取求助 → 落任务
say('## 9) 小犀收下求助，便签落成本机任务');
say('```text');
say(textOf(await A.hub.call('pet_visit', { action: 'receive', note: askJson, teamId, fallback: '' })));
say('```');
say('');

// 9. 看板
say('## 10) 小犀的任务板里真多了一条（来自小鹿）');
say('```text');
say(textOf(await A.hub.call('team_board', { action: 'list', teamId })));
say('```');
say('');

// 10. 串门记录
say('## 11) 两边的串门记录（各自落盘 .agentdeck/pet/visits.log）');
say('```text');
say(textOf(await A.hub.call('pet_visit', { action: 'log', limit: 10 })));
say('```');
say('');
say('```text');
say(textOf(await B.hub.call('pet_visit', { action: 'log', limit: 10 })));
say('```');
say('');

// 11. 皮肤
say('## 12) 皮肤：列出来（含付费那套）、换装、四种状态真渲染');
say('```text');
say(textOf(await A.hub.call('pet_skin', { action: 'list' })));
say('```');
say('');
say('```text');
say(textOf(await A.hub.call('pet_skin', { action: 'activate', id: 'premium-aurora' })));
say('```');
say('');
say('```text');
say(textOf(await A.hub.call('pet_skin', { action: 'states' })));
say('```');
say('');

const svgs = {};
for (const state of ['idle', 'working', 'meeting', 'visiting', 'sleeping']) {
  const res = await A.hub.call('pet_skin', { action: 'render', id: 'premium-aurora', state, size: 160 });
  const raw = res.find((b) => b.type === 'text')?.text || '';
  const svg = (raw.match(/<svg[\s\S]*<\/svg>/) || [])[0] || '';
  svgs[state] = svg;
  say(`### 极光 / ${state}`);
  say('```text');
  say(svg ? `（SVG ${svg.length} 字节，见 docs/evidence/pet-skins-1.6.4.html）` : raw.slice(0, 200));
  say('```');
}

// 皮肤画廊 HTML
const gallery = `<!doctype html>
<meta charset="utf-8">
<title>Nexi 桌宠皮肤 · 1.6.4</title>
<style>
  body{font-family:"Microsoft YaHei",system-ui,sans-serif;background:#141210;color:#f3ece2;margin:0;padding:32px}
  h1{font-size:22px;margin:0 0 6px} .sub{color:#a89a88;font-size:13px;margin-bottom:24px}
  .grid{display:flex;gap:20px;flex-wrap:wrap}
  .card{background:#1f1b17;border:1px solid #372f27;border-radius:14px;padding:16px;width:208px;text-align:center}
  .card h2{font-size:14px;margin:8px 0 2px} .card p{color:#a89a88;font-size:12px;margin:0}
  svg{width:150px;height:150px;display:block;margin:0 auto}
</style>
<h1>极光皮肤 · 五种状态真渲染</h1>
<div class="sub">由 pet_skin render 直接输出 SVG，未经过任何设计工具；尺寸 160×160。</div>
<div class="grid">
${Object.entries(svgs).map(([state, svg]) => `<div class="card">${svg || '<p>（没渲染出来）</p>'}<h2>${state}</h2><p>pet_skin render · premium-aurora</p></div>`).join('\n')}
</div>`;
writeFileSync(join(PKG, 'docs', 'evidence', 'pet-skins-1.6.4.html'), gallery, 'utf8');
say('');
say(`画廊已写出：docs/evidence/pet-skins-1.6.4.html（${Object.values(svgs).filter(Boolean).length}/5 套状态有 SVG）`);



// 12. 免费版下换付费皮肤：应当被明确拒绝（带价格）
say('## 13) 没有授权的那台机器换付费皮肤——被明确拒绝，不偷偷降级');
const C = await mkHub('hostC', '小白的桌宠', { license: false });
say('```text');
say(textOf(await C.hub.call('pet_skin', { action: 'activate', id: 'premium-aurora' })));
say('```');
say('');
say('```text');
say(textOf(await C.hub.call('deck_license', { action: 'status' })));
say('```');
say('');
await C.hub.close();

writeFileSync(OUT, lines.join('\n') + '\n', 'utf8');
console.log(`\n[written] ${OUT}`);

await A.hub.close();
await B.hub.close();
if (ownedDemo) rmSync(DEMO, { recursive: true, force: true });
