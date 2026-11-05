#!/usr/bin/env node
/**
 * 卖家侧的授权工具（发码 / 验码 / 装机）
 *
 * 这是"收费能真实做到"的执行件：客户付钱（收款码 / 爱发电 / Gumroad），
 * 你在这台机器上跑一条命令生成授权码发给他，他贴进插件即生效。
 * 不依赖任何服务器、不需要网站、不需要公司主体。
 *
 * 用法：
 *   node tools/license-cli.mjs init                          # 生成签发密钥对（只做一次）
 *   node tools/license-cli.mjs issue --tier pro --to 张三 --days 365
 *   node tools/license-cli.mjs issue --tier studio --to 李四 --days 365 --skins aurora,ink
 *   node tools/license-cli.mjs verify ADSK1.xxx.yyy
 *   node tools/license-cli.mjs entitlements
 *   node tools/license-cli.mjs activate --root D:\某工作区 ADSK1.xxx.yyy
 *   node tools/license-cli.mjs orders                          # 看已发出的码
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  TIERS,
  PRICE_TABLE,
  encodeLicense,
  verifyLicense,
  entitlements,
  describeEntitlements,
  writeLicenseKey,
} from '../lib/license.js';

const DEFAULT_DIR = join(homedir(), '.agentdeck-issuer');
const DEFAULT_PRIV = join(DEFAULT_DIR, 'issuer-private.pem');
const DEFAULT_ORDERS = join(DEFAULT_DIR, 'issued.jsonl');

function arg(flag, fallback = undefined) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function cmdInit() {
  const dir = resolve(String(arg('--out', DEFAULT_DIR)));
  ensureDir(dir);
  const privPath = join(dir, 'issuer-private.pem');
  if (existsSync(privPath)) die(`已经存在签发私钥：${privPath}（不要覆盖，覆盖后老客户的全废）`);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  writeFileSync(privPath, privPem, { mode: 0o600 });
  writeFileSync(join(dir, 'issuer-public.pem'), pubPem);
  writeFileSync(join(dir, 'public-key.txt'), pubB64, 'utf8');
  console.log('✓ 签发密钥已生成');
  console.log(`  私钥（保密，别提交到 git）：${privPath}`);
  console.log(`  公钥 base64url：${pubB64}`);
  console.log('\n把上面这行公钥写进 lib/license.js 的 ISSUER_PUBLIC_SPKI_B64URL（只需一次）。');
}

function cmdIssue() {
  const keyPath = resolve(String(arg('--key', DEFAULT_PRIV)));
  if (!existsSync(keyPath)) die(`找不到签发私钥：${keyPath}\n  先跑 node tools/license-cli.mjs init`);
  const tier = String(arg('--tier', 'pro')).toLowerCase();
  if (!TIERS[tier]) die(`档位不对：${tier}（可选 ${Object.keys(TIERS).join(' / ')}）`);
  const to = String(arg('--to', ''));
  if (!to || to === 'true') die('必须写清客户标识：--to "张三 / 微信昵称 / 订单号"');
  const days = Math.max(1, Math.floor(Number(arg('--days', 365)) || 365));
  const nowSec = Math.floor(Date.now() / 1000);
  const skinsRaw = arg('--skins', '');
  const skins = skinsRaw && skinsRaw !== true ? String(skinsRaw).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const tierDef = TIERS[tier];
  const claims = {
    v: 1,
    id: `lic_${randomBytes(6).toString('hex')}`,
    tier,
    sub: to,
    iat: nowSec,
    exp: nowSec + days * 86400,
    seats: Math.max(1, Math.floor(Number(arg('--seats', tierDef.maxSeats)) || tierDef.maxSeats)),
    skins,
  };
  const key = encodeLicense(claims, readFileSync(keyPath, 'utf8'));
  const check = verifyLicense(key);
  if (!check.ok) die(`自检失败（生成的码自己都验不过）：${check.reason}`);

  ensureDir(DEFAULT_DIR);
  appendFileSync(
    DEFAULT_ORDERS,
    JSON.stringify({ ...claims, price: tierDef.price, issuedAt: new Date().toISOString(), key }) + '\n',
    'utf8',
  );

  console.log('✓ 授权码已生成（复制下面整行发给客户）\n');
  console.log(key);
  console.log(`\n  档位：${tierDef.label}（¥${tierDef.price}/月参考价）`);
  console.log(`  客户：${to}`);
  console.log(`  到期：${new Date(claims.exp * 1000).toLocaleString('zh-CN')}（${days} 天）`);
  console.log(`  席位：${claims.seats}${skins.length ? `  皮肤：${skins.join(',')}` : ''}`);
  console.log(`  订单记录：${DEFAULT_ORDERS}`);
  console.log('\n客户怎么用：DSH 里执行 /deck 打开状态页 → 粘贴授权码 → 回车。或直接写文件：');
  console.log('  <工作区>\\.agentdeck\\license\\key.txt');
}

function cmdVerify() {
  const key = process.argv[3];
  if (!key) die('用法：verify <授权码>');
  const v = verifyLicense(key);
  if (!v.ok) {
    console.log(`✗ 无效：${v.reason}（code=${v.code}）`);
    process.exit(2);
  }
  console.log('✓ 有效');
  console.log(JSON.stringify(v.claims, null, 2));
  console.log(describeEntitlements(entitlementsOf(v)));
}

function entitlementsOf(v) {
  return v && v.ok ? entitlements(v.tier) : entitlements('free');
}

function cmdEntitlements() {
  console.log('档位对比（代码里所有能力判断的唯一真源）：\n');
  const rows = PRICE_TABLE.map((p) => {
    const e = TIERS[p.tier];
    return {
      档位: p.name,
      价格: p.price + p.per,
      本地房间: e.localRooms,
      云房间: e.cloudRooms,
      席位: e.maxSeats,
      并行: e.parallel,
      会议轮次: e.meetingRounds,
      付费皮肤: e.premiumSkins ? '✓' : '—',
      跨机邀请: e.remoteJoin ? '✓' : '—',
      自动执行: e.autoRun ? '✓' : '—',
    };
  });
  console.table(rows);
  for (const p of PRICE_TABLE) console.log(`· ${p.name}：${p.sell}`);
}

function cmdActivate() {
  const root = resolve(String(arg('--root', process.cwd())));
  const key = process.argv[process.argv.indexOf('--root') + 2] || process.argv[3];
  if (!key || key.startsWith('--')) die('用法：activate --root <工作区> <授权码>');
  const v = verifyLicense(key);
  if (!v.ok) die(`授权码无效：${v.reason}`);
  const w = writeLicenseKey(root, key);
  if (!w.ok) die(w.reason);
  console.log(`✓ 已写入 ${w.path}`);
  console.log(describeEntitlements(entitlementsOf(v)));
}

function cmdOrders() {
  if (!existsSync(DEFAULT_ORDERS)) {
    console.log('还没有发出过授权码。');
    return;
  }
  const lines = readFileSync(DEFAULT_ORDERS, 'utf8').split('\n').filter(Boolean);
  const rows = lines.map((l) => {
    try {
      const o = JSON.parse(l);
      return {
        客户: o.sub,
        档位: o.tier,
        到期: new Date(o.exp * 1000).toLocaleDateString('zh-CN'),
        签发: new Date(o.issuedAt).toLocaleDateString('zh-CN'),
        收入: `¥${o.price || 0}`,
      };
    } catch {
      return { 客户: '(损坏行)', 档位: '-', 到期: '-', 签发: '-', 收入: '-' };
    }
  });
  console.table(rows);
  const total = lines.reduce((sum, l) => {
    try {
      return sum + (Number(JSON.parse(l).price) || 0);
    } catch {
      return sum;
    }
  }, 0);
  console.log(`合计（按首月参考价）：¥${total}`);
}

const cmd = process.argv[2];
const table = {
  init: cmdInit,
  issue: cmdIssue,
  verify: cmdVerify,
  entitlements: cmdEntitlements,
  activate: cmdActivate,
  orders: cmdOrders,
};
if (!table[cmd]) {
  console.log('agentdeck-super 授权工具\n');
  console.log('  init                            生成签发密钥对（一次性）');
  console.log('  issue --tier pro --to 张三 --days 365   发一张授权码');
  console.log('  verify <授权码>                 验证一张码');
  console.log('  entitlements                    看档位对比');
  console.log('  activate --root <工作区> <授权码>  直接装到某工作区');
  console.log('  orders                          看已发出的码与合计');
  process.exit(cmd ? 1 : 0);
}
table[cmd]();
