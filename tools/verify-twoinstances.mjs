#!/usr/bin/env node
/**
 * tools/verify-twoinstances.mjs —— 「买完换台电脑还能不能用」的真实演练
 *
 * 这一条是收钱这件事最容易断的地方：
 *   买家在 A 电脑付了钱、皮肤能用了；第二天在公司电脑 B 上装同一个插件 ——
 *   还算不算他买的？还是又要再付一次？
 *
 * 单机账本做不到（A 的 market/ledger.json 拷不过去也用不了：账本带 HMAC 封印，
 * 换台机器密钥不同就是一份"被改过的文件"）。能跟人走的只有那串 ADSK1 授权码。
 * 所以这里验的就是：**只有那串码**的情况下，B 能不能用；以及伪造的码能不能拦住。
 *
 * 两台"电脑"是同一个进程里两个独立的 root（各自一份 market 目录、各自的封印密钥），
 * 走的是**真实的工具层**（deck_market / deck_license），不是直接调内部函数 ——
 * 中间任何一层文案或分支写错，这里就会红。
 *
 * 用法：node tools/verify-twoinstances.mjs
 * 证据：docs/evidence/twoinstances-<版本>.txt
 */

import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMarket } from '../lib/market/index.js';
import { createMarketTool } from '../lib/tools/market.js';
import { createLicenseTool } from '../lib/tools/license.js';
import * as license from '../lib/license.js';

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const OUT = join(REPO, 'docs', 'evidence', `twoinstances-${VERSION}.txt`);

const SKIN = 'premium-nebula';   // ¥28，四套付费里最便宜的一套，价格好核对
const PRICE = 2800;              // 分
const LOCAL_SKIN = 'premium-aurora'; // 只买本机凭据（不签码）的那套，用来证明"拷文件白拿不到"

const lines = [];
let pass = 0;
let fail = 0;
const ok = (n, e = '') => { pass += 1; lines.push(`  ✅ ${n}${e ? ` —— ${e}` : ''}`); };
const bad = (n, e = '') => { fail += 1; lines.push(`  ❌ ${n}${e ? ` —— ${e}` : ''}`); };
const chk = (c, n, e = '') => (c ? ok(n, e) : bad(n, e));
const note = (t) => lines.push(`  · · ${t}`);
const say = (t = '') => lines.push(t);

/**
 * 签发密钥：优先用卖家本机那对真密钥。
 * 用它签出来的码，要能被**打包进插件的内置公钥**验过 —— 这才叫端到端。
 * 机器上没有（CI / 别人的电脑）就造一对临时的，并把公钥挂进环境变量，
 * 绝不因为"验收脚本需要私钥"就让用户先手工 init 才能跑。
 */
function pickIssuer() {
  const pem = join(homedir(), '.agentdeck-issuer', 'issuer-private.pem');
  if (existsSync(pem)) {
    const priv = readFileSync(pem, 'utf8');
    // 确认内置公钥真的跟这把私钥配对，不然下面所有"验签通过"都是假的
    const probe = license.encodeLicense({ tier: 'free', sub: 'probe', iat: Math.floor(Date.now() / 1000) }, priv);
    const v = license.verifyLicense(probe);
    if (v.ok) return { priv, real: true, why: '本机签发密钥（与插件内置公钥配对）' };
    return { priv, real: false, why: '本机签发密钥与内置公钥**不配对**（下面要用临时密钥）', mismatch: true };
  }
  return { priv: null, real: false, why: '本机没有签发密钥，改用临时密钥对' };
}

function makeTempIssuer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  return { priv: privateKey.export({ type: 'pkcs8', format: 'pem' }), pub };
}

/** 一张"电脑"：独立 root + 独立市场 + 独立授权目录 */
function machine(tag) {
  const root = mkdtempSync(join(tmpdir(), `adsk-2i-${tag}-`));
  const market = createMarket({ root, billing: null });
  const marketTool = createMarketTool({ market, billing: null });
  const licenseTool = createLicenseTool({
    root,
    // licenseRoot 的语义是「.agentdeck/license/key.txt 挂在哪个根下」，不是那个目录本身。
    // 传成 <root>/.agentdeck/license 会变成 <root>/.agentdeck/license/.agentdeck/license/key.txt，
    // 工具说"授权已启用"、货架却读不到 —— 这类错位最难查（第一版这个脚本就踩了）。
    licenseRoot: () => root,
    license,
  });
  return {
    tag,
    root,
    market,
    paths: market.paths,
    run: (args) => marketTool.execute(args, {}),
    lic: (args) => licenseTool.execute(args, {}),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const text = (r) => (r && typeof r === 'object' && typeof r.text === 'string' ? r.text : String(r || ''));

async function main() {
  say(`两台独立实例的市场全流程（v${VERSION}）`);
  say(`  · 皮肤：${SKIN}（¥${PRICE / 100}）`);
  say(`  · 两台"电脑"= 两个独立 root，各自一份 market/ 目录与封印密钥`);
  say(`  · 全程走工具层（deck_market / deck_license），不直接调内部函数`);
  say();

  const issuer = pickIssuer();
  let priv = issuer.priv;
  let issuerNote = issuer.why;
  if (!priv || issuer.mismatch) {
    const tmp = makeTempIssuer();
    priv = tmp.priv;
    process.env.AGENTDECK_LICENSE_PUBKEY = tmp.pub;
    issuerNote = `${issuerNote}（临时公钥已注入 AGENTDECK_LICENSE_PUBKEY）`;
  }
  say(`签发方：${issuerNote}`);
  say();

  const nowSec = Math.floor(Date.now() / 1000);
  const code = license.encodeLicense({
    tier: 'free',
    sub: '买家-王先生',
    iat: nowSec,
    exp: nowSec + 365 * 86400,
    skins: [SKIN],
  }, priv);

  const A = machine('A');
  const B = machine('B');
  try {
    // ── 一、旧电脑 A：下单 → 人工确认 → 能用 ─────────────────────────────
    say('一、旧电脑 A：买家付钱、卖家确认');
    const shelf0 = text(await A.run({ action: 'catalog' }));
    chk(/premium-nebula|星云/.test(shelf0), 'A 货架上能看到这套皮肤');
    chk(/说「买 premium-nebula」/.test(shelf0), 'A 一开始是锁着的（新设备本来就该锁）');

    const placedText = text(await A.run({ action: 'place', skinId: SKIN }));
    const orderId = (placedText.match(/ord_[A-Za-z0-9_-]+/) || [])[0] || '';
    chk(!!orderId, 'A 下单成功，拿到订单号', orderId);
    chk(new RegExp(`¥${PRICE / 100}`).test(placedText), '订单页面标出真实金额 ¥28');

    const confText = text(await A.run({
      action: 'confirm',
      orderId,
      paymentRef: '支付宝-2026110900001',
      licenseKey: code,
    }));
    chk(/已确认到账/.test(confText), 'A 人工确认到账并发放');
    chk(/签名授权：已随订单存档/.test(confText), 'A 的订单里存下了签名授权码');

    const shelfA = A.market.catalog().skins.find((s) => s.id === SKIN);
    chk(shelfA?.owned === true, 'A 买完就能用');
    chk(shelfA?.grantedBy === 'signed', 'A 的凭据来源是「已验签授权」，不是"本机账本说了算"');

    const ledgerRaw = JSON.parse(readFileSync(A.paths.ledgerFile, 'utf8'));
    chk(/^hmac-sha256:[0-9a-f]{64}$/.test(String(ledgerRaw.seal)), 'A 的账本带 HMAC 封印');
    chk(ledgerRaw.purchases?.[0]?.amount === PRICE, 'A 的购买记录记下了金额（对账/交叉核对靠它）');

    // 再买一套**不带授权码**的（纯本机凭据）：后面要拿它证明"拷文件没用"
    const localOrder = text(await A.run({ action: 'place', skinId: LOCAL_SKIN }));
    const localOrderId = (localOrder.match(/ord_[A-Za-z0-9_-]+/) || [])[0] || '';
    const localConf = text(await A.run({
      action: 'confirm', orderId: localOrderId, paymentRef: '微信-2026110900003',
    }));
    chk(/没附签名授权码/.test(localConf), '另一套不带授权码的购买：本机可用，但工具当场说清"只在这台机器有效"');
    say();

    // ── 二、换到新电脑 B：只有那串码 ────────────────────────────────────
    say('二、新电脑 B：手里只有那串授权码');
    const shelfB0 = B.market.catalog().skins.find((s) => s.id === SKIN);
    chk(shelfB0?.owned === false, 'B 是干净设备，一开始没这套皮肤');

    // 场景 A：买家把 A 的账本/订单整份拷到 B（最常见的误解："文件拷过去就行"）
    // 拷的是两份 JSON，不带隐藏的封印密钥 —— 现实里换电脑就是这样。
    mkdirSync(join(B.root, 'market'), { recursive: true });
    for (const f of ['ledger.json', 'orders.json']) {
      const src = join(A.root, 'market', f);
      if (existsSync(src)) writeFileSync(join(B.root, 'market', f), readFileSync(src));
    }
    const shelfCopied = B.market.catalog();
    const copiedLocal = shelfCopied.skins.find((s) => s.id === LOCAL_SKIN);
    chk(copiedLocal?.owned === false, `拷文件拿不走"纯本机凭据"那套（${LOCAL_SKIN}）`);
    chk(
      (shelfCopied.warnings || []).some((w) => /封印|改过|不采信/.test(w)),
      '而且明确报警，不是默默当成没买过',
      (shelfCopied.warnings || [])[0] || '',
    );
    // 带签名码的那套会解锁 —— 这不是漏洞：解锁它的是账本里夹着的那串**卖家真签的码**，
    // 换成自己编一串塞进去就没用了（见下面第三节）。
    const copiedSigned = shelfCopied.skins.find((s) => s.id === SKIN);
    note(
      `拷过去后 ${SKIN} 变成可用（${copiedSigned?.grantedBy || '?'}）：靠的是账本里夹着的那串签名码，`
      + '不是"文件被采信了"——同一份文件里另一套没有码的皮肤仍然锁着。',
    );

    // 场景 B：把拷来的账本删干净，只粘那串码（这才是换电脑的正路）
    rmSync(join(B.root, 'market'), { recursive: true, force: true });
    const actText = text(await B.lic({ action: 'activate', key: code }));
    chk(/授权已启用/.test(actText), 'B 上粘贴授权码：校验通过并写盘');
    chk(existsSync(join(B.root, '.agentdeck', 'license', 'key.txt')), 'B 的授权文件确实落在了本机');

    const shelfB1 = B.market.catalog().skins.find((s) => s.id === SKIN);
    chk(shelfB1?.owned === true, 'B 只用这串码就解锁了这套皮肤');
    chk(shelfB1?.grantedBy === 'signed', 'B 的来源也是「已验签授权」');
    const bLocal = B.market.catalog().skins.find((s) => s.id === LOCAL_SKIN);
    chk(bLocal?.owned === false, `另一套没签码的皮肤在 B 上仍然锁着（授权码是点名的，不是万能钥匙）`);
    say();

    // ── 三、攻击者：伪造/篡改/过期/别人的码 ─────────────────────────────
    say('三、伪造的码能不能骗过去');
    const parts = code.split('.');
    const flip = (s) => {
      const i = Math.floor(s.length / 2);
      return s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);
    };
    const forgedSig = `${parts[0]}.${parts[1]}.${flip(parts[2])}`;
    const forgedSigText = text(await B.lic({ action: 'activate', key: forgedSig }));
    chk(/没通过校验/.test(forgedSigText), '改掉签名里一个字符 → 被拒');
    chk(/签名不匹配/.test(forgedSigText), '拒绝原因说清是签名不匹配（不是含糊的"无效"）');

    // 把 payload 里的 skins 改成 ["*"]：想白拿全部付费皮肤
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const forgedPayload = `${parts[0]}.${Buffer.from(JSON.stringify({ ...payload, skins: ['*'] })).toString('base64url')}.${parts[2]}`;
    const forgedPayloadText = text(await B.lic({ action: 'activate', key: forgedPayload }));
    chk(/没通过校验/.test(forgedPayloadText), '把授权范围改成 ["*"] → 被拒（改内容就毁签名）');

    const expired = license.encodeLicense({
      tier: 'free', sub: '过期码', iat: nowSec - 7200, exp: nowSec - 3600, skins: [SKIN],
    }, priv);
    const expiredText = text(await B.lic({ action: 'activate', key: expired }));
    chk(/没通过校验/.test(expiredText), '过期码 → 被拒');
    chk(/过期|到期/.test(expiredText), '拒绝原因提到已过期');

    const otherPriv = makeTempIssuer().priv;
    const foreign = license.encodeLicense({
      tier: 'free', sub: '别人签的', iat: nowSec, exp: nowSec + 86400, skins: [SKIN],
    }, otherPriv);
    const foreignText = text(await B.lic({ action: 'activate', key: foreign }));
    chk(/没通过校验/.test(foreignText), '别人用自己的密钥签的码 → 被拒（换密钥=换发行方）');

    const stillOk = B.market.catalog().skins.find((s) => s.id === SKIN);
    chk(stillOk?.owned === true, '四次伪造尝试之后，B 手里那张真码依然有效（没被写坏/挤掉）');
    say();

    // ── 四、退款：能收回什么、收不回什么 ────────────────────────────────
    say('四、退款');
    const refText = text(await A.run({
      action: 'refund', orderId, refundRef: '支付宝-退款-2026110900002',
    }));
    chk(/已退款|退回/.test(refText), 'A 的退款登记成功');
    const afterRefundA = A.market.catalog().skins.find((s) => s.id === SKIN);
    chk(afterRefundA?.owned === false, '退款后 A 上的凭据被收回（不会"退钱还留皮肤"）');

    const afterRefundB = B.market.catalog().skins.find((s) => s.id === SKIN);
    note(
      afterRefundB?.owned === true
        ? 'B 上仍然可用 —— 这是**离线签名码的已知边界**：码一旦发出去，没有服务器就收不回来。'
        : 'B 上也失效了（意外，应该记录）',
    );
    note('要真能吊销只有两条路：① 签短期码（到期自然失效）② 上在线校验服务。docs/PAY.md 已写明。');
    say();

    // ── 汇总 ────────────────────────────────────────────────────────────
    say(`结果：${pass} 通过 / ${fail} 失败`);
    say('');
    say('这台机器上的关键结论：');
    say('  · 换电脑的正路是**那串码**：B 上没有任何 A 的账本，只有码，照样能用。');
    say('  · 拷账本文件带不走"本机凭据"（封印拦着）；但账本里如果夹着签名码，那串码本身在哪都有效。');
    say('    锁住"白拿"的是签名，不是文件 —— 自己编一串塞进账本没用。');
    say('  · 码改一个字符、改授权范围、过期、别人签的 —— 四种伪造全部拦下。');
    say('  · 退款能收回本机凭据，但发出去的码在离线世界里收不回（要吊销得上服务）。');
  } finally {
    A.cleanup();
    B.cleanup();
  }

  const out = lines.join('\n');
  console.log(out);
  try {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, `${out}\n`, 'utf8');
    console.log(`\n证据已写入：${OUT}`);
  } catch (err) {
    console.log(`\n证据没写成：${err?.message || err}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('演练脚本自己崩了：', err);
  process.exit(2);
});
