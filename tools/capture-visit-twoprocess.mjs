#!/usr/bin/env node
/**
 * 串门：**两个独立进程、两个独立工作区**的真往返（用于 docs/evidence/visit-twoprocess-1.6.4.txt）
 *
 * 和 capture-visit.mjs 的区别：
 *   - capture-visit.mjs：同一个进程里造两个 Hub（证明工具链自洽）；
 *   - 本脚本：每一步都 spawn 一个**全新的 node 进程**调 `bin/nexi.mjs call`，
 *     靠盘上的文件传递邀请函 / 便签——和"两个用户各自在自己电脑上操作"最接近。
 *
 * 用法：node tools/capture-visit-twoprocess.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXI = join(PKG, 'bin', 'nexi.mjs');
const DEMO = process.env.NEXI_VISIT_ROOT || mkdtempSync(join(tmpdir(), 'nexi-visit2-'));
const ownedDemo = !process.env.NEXI_VISIT_ROOT;
const OUT = join(PKG, 'docs', 'evidence', 'visit-twoprocess-1.6.5.txt');

const lines = [];
const say = (t = '') => { lines.push(t); console.log(t); };

/** 起一个全新进程，在指定主机上调一个工具，返回纯文本输出 */
function call(host, tool, args) {
  const env = {
    ...process.env,
    NEXI_WORKSPACE: join(DEMO, host, 'work'),
    NEXI_BOARD_ROOT: join(DEMO, host, 'board'),
    NEXI_PET_ROOT: join(DEMO, host, 'work'),
    NEXI_LICENSE_ROOT: join(DEMO, host, 'lic'),
  };
  const raw = execFileSync(process.execPath, [NEXI, 'call', tool, JSON.stringify(args)], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return raw.split(/\r?\n/).filter((l) => !/^\[nexi:info\]/.test(l)).join('\n').trim();
}

rmSync(DEMO, { recursive: true, force: true });
const NAMES = { xiaoxi: '小犀', xiaolu: '小鹿' };
for (const host of ['xiaoxi', 'xiaolu']) {
  const work = join(DEMO, host, 'work');
  mkdirSync(join(work, '.agentdeck', 'pet'), { recursive: true });
  mkdirSync(join(DEMO, host, 'board'), { recursive: true });
  // 桌宠档案就是普通的 JSON：直接按公开结构写一份，避免这个脚本依赖仓库内部 API
  writeFileSync(join(work, '.agentdeck', 'pet', 'profile.json'), JSON.stringify({
    version: 1,
    name: NAMES[host],
    createdAt: new Date().toISOString(),
    skins: { owned: ['basic'], active: 'basic' },
    traits: {}, habits: [], stats: {},
    persona: { tone: '简洁', language: 'zh' },
  }, null, 2), 'utf8');
}

const ver = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;
say(`# 串门：两个独立进程、两个独立工作区（${ver}）`);
say('');
say(`- 时间：${new Date().toISOString()}`);
say(`- 版本：agentdeck-super@${ver}`);
say(`- 小犀的工作区：${join(DEMO, 'xiaoxi', 'work')} ｜ 小鹿的工作区：${join(DEMO, 'xiaolu', 'work')}`);
say('- 每一步都是 `node bin/nexi.mjs call …` 起的**全新进程**，两边的状态只靠盘上文件传递。');
say('');

say('## 1) 小犀（独立进程 #1）发邀请函');
const invite = call('xiaoxi', 'pet_visit', { action: 'invite', scope: 'work', ttlHours: 4 });
const token = (invite.match(/[?&]t=([A-Za-z0-9._~-]+)/) || [])[1] || '';
say('```text');
say(token ? invite.replaceAll(token, `<邀请令牌已脱敏，长度 ${token.length}>`) : invite);
say('```');
writeFileSync(join(DEMO, 'invite.token'), token, 'utf8');
say('');

say('## 2) 小鹿（独立进程 #2）收下邀请函');
say('```text');
say(call('xiaolu', 'pet_visit', { action: 'accept', token, expectedScope: 'work' }));
say('```');
say('');

say('## 3) 小鹿那台的皮肤清单（顺手确认两个工作区互不干扰）');
say('```text');
const setB = call('xiaolu', 'pet_skin', { action: 'list' });
say(setB);
say('```');
say('');

say('## 4) 小犀建组（独立进程 #3）');
const teamOut = call('xiaoxi', 'team_board', { action: 'create', name: '跨进程串门', goal: '证明两个独立进程能靠盘上文件走完串门', members: ['小犀'] });
say('```text');
say(teamOut);
say('```');
const teamId = (teamOut.match(/team_[0-9a-f]{6,}/i) || [])[0] || '';
say('');

say('## 5) 小鹿（独立进程 #4）发一张求助便签');
const ask = call('xiaolu', 'pet_visit', { action: 'ask', to: '小犀', title: '帮我review一下这个正则', acceptance: '指出至少一处回溯风险', role: 'reviewer' });
say('```text');
say(ask);
say('```');
const askJson = (ask.match(/```json\n([\s\S]*?)```/) || [])[1] || '';
writeFileSync(join(DEMO, 'ask.note.json'), askJson, 'utf8');
say('');

say('## 6) 小犀（独立进程 #5）收下求助 —— 便签落到任务板');
say('```text');
say(call('xiaoxi', 'pet_visit', { action: 'receive', note: askJson, teamId }));
say('```');
say('');

say('## 7) 小犀（独立进程 #6）看板子：任务真在');
say('```text');
say(call('xiaoxi', 'team_board', { action: 'list', teamId }));
say('```');
say('');

say('## 8) 两边的串门记录（各自盘上）');
say('```text');
say(call('xiaoxi', 'pet_visit', { action: 'log', limit: 10 }));
say('```');
say('');
say('```text');
say(call('xiaolu', 'pet_visit', { action: 'log', limit: 10 }));
say('```');
say('');

say('## 9) 冒名顶替：把小犀名片上的名字改掉，签名立刻对不上');
// 保留原签名、只改 body —— 等价于「有人在中途改了一个字」
const [bodyB64, sigB64] = token.split('.');
const forgedPayload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
forgedPayload.from.name = '冒充的小犀';
const forged = `${Buffer.from(JSON.stringify(forgedPayload)).toString('base64url')}.${sigB64}`;
say('```text');
say(call('xiaolu', 'pet_visit', { action: 'accept', token: forged, expectedScope: 'work' }));
say('```');
say('');
say('> 这一条是小鹿那台的**独立进程**给出的判断：它没有小犀的私钥，公钥又只能验不能签，');
say('> 所以改过的名片一定过不去。签名只证明「没被改过」+「是 kid_ 那把钥匙签的」，');
say('> 不证明「这把钥匙真属于某个真人」——身份绑定（TOFU / 域名 / DID）还没做，不吹。');
say('');

say('## 10) 盘上真的落了这些文件');
for (const rel of [
  'xiaoxi/work/.agentdeck/pet/visits.log',
  'xiaolu/work/.agentdeck/pet/visits.log',
  'xiaoxi/work/.agentdeck/pet/visit-key.json',
]) {
  const p = join(DEMO, rel);
  say(`- ${rel} → ${existsSync(p) ? `${readFileSync(p, 'utf8').split('\n').filter(Boolean).length} 行` : '（没有）'}`);
}
say('');
say('```text');
say(readFileSync(join(DEMO, 'xiaoxi/work/.agentdeck/pet/visits.log'), 'utf8').trim());
say('```');
say('');
say('> 邀请令牌不写进证据；`visit-key.json` 是本机签名密钥对（私钥不出门），只报"文件在不在"，不打印内容。');

writeFileSync(OUT, `${lines.join('\n')}\n`, 'utf8');
console.log(`\n[written] ${OUT}`);
if (ownedDemo) rmSync(DEMO, { recursive: true, force: true });
