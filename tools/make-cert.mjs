/**
 * tools/make-cert.mjs —— 生成一张自签 TLS 证书（给 relay 的 HTTPS 用）
 *
 * 为什么需要它：relay 现在是 HTTP；公网部署不带 TLS 等于内容裸奔。
 * 而自建用户机器上通常没有 openssl / mkcert，让"想加密"的人先装一堆工具
 * 是个假门槛。Node 本身能生成密钥对，X.509 的 DER 我们自己拼——
 * 只用一个自签场景，够用且不引依赖。
 *
 * 产出：
 *   <out>/relay-cert.pem   证书
 *   <out>/relay-key.pem    私钥
 *
 * 用法：
 *   node tools/make-cert.mjs                      # 写到 ./certs
 *   node tools/make-cert.mjs --out D:\certs --days 365 --cn 192.168.1.10
 *
 * 诚实边界：
 *   · 自签证书**浏览器会报不受信任**——这是自签的必然，不是 bug。
 *     局域网自用可以；要给别人用就去申请真证书（Let's Encrypt 免费）。
 *   · 这里不做 CA、不做证书链、不做吊销。
 *   · 生成的私钥是明文的，注意保管（别提交进仓库）。
 */

import { generateKeyPairSync, createHash, randomBytes, sign as cryptoSign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/* ── 极简 DER 编码（只覆盖 X.509 需要的几种类型）────────────────────── */

function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), len(content.length), content]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (buf) => tlv(0x02, buf);
const bitStr = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const octet = (buf) => tlv(0x04, buf);
const nullTag = () => Buffer.from([0x05, 0x00]);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));

/** 小整数编码（版本号/序列号）。 */
function smallInt(n) {
  const bytes = [];
  let v = n;
  do { bytes.unshift(v & 0xff); v >>= 8; } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return int(Buffer.from(bytes));
}

/** UTF8String */
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));

/** PrintableString（国家代码用） */
const printable = (s) => tlv(0x13, Buffer.from(String(s), 'ascii'));

/** OID 编码 */
function oid(dotted) {
  const parts = String(dotted).split('.').map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const chunk = [];
    let v = p;
    do { chunk.unshift(v & 0x7f); v >>= 7; } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime：YYMMDDHHMMSSZ */
function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

/* ── OID 常量 ─────────────────────────────────────────────────────────── */
const OID = {
  sha256WithRsa: '1.2.840.113549.1.1.11',
  rsaEncryption: '1.2.840.113549.1.1.1',
  cn: '2.5.4.3',
  o: '2.5.4.10',
  c: '2.5.4.6',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

/** Name = SEQUENCE OF RDN */
function name(entries) {
  return seq(...entries.map(([oidStr, value, asPrintable]) => set(seq(oid(oidStr), asPrintable ? printable(value) : utf8(value)))));
}

/** GeneralNames：DNS 或 IP */
const dnsName = (s) => tlv(0x82, Buffer.from(String(s), 'ascii'));
const ipAddress = (s) => {
  const parts = String(s).split('.').map(Number);
  return tlv(0x87, Buffer.from(parts));
};

/**
 * 造一张自签证书。
 * @returns {{certPem:string, keyPem:string, sha256:string}}
 */
export function makeSelfSignedCert({ cn = 'localhost', days = 365, altNames = [], org = 'AgentDeck Self-Signed' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const now = new Date();
  const notBefore = new Date(now.getTime() - 60 * 1000); // 往前留一分钟，免得时钟差导致"尚未生效"
  const notAfter = new Date(now.getTime() + Number(days) * 24 * 60 * 60 * 1000);

  const serial = randomBytes(16);
  serial[0] &= 0x7f; // 正数

  // SAN：至少带上 cn；cn 像 IP 就按 IP 编码
  const names = [...new Set([cn, ...altNames])].filter(Boolean);
  const sanParts = names.map((n) => (/^\d+\.\d+\.\d+\.\d+$/.test(n) ? ipAddress(n) : dnsName(n)));

  const extensions = seq(
    // basicConstraints: CA=false
    seq(oid(OID.basicConstraints), bool(true), octet(seq())),
    // keyUsage: digitalSignature | keyEncipherment
    seq(oid(OID.keyUsage), bool(true), octet(tlv(0x03, Buffer.from([0x05, 0xa0])))),
    // extKeyUsage: serverAuth
    seq(oid(OID.extKeyUsage), octet(seq(oid(OID.serverAuth)))),
    // subjectAltName
    seq(oid(OID.subjectAltName), octet(seq(...sanParts))),
  );

  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const issuer = name([[OID.c, 'CN', true], [OID.o, org], [OID.cn, cn]]);
  const subject = issuer; // 自签：issuer == subject

  const tbs = seq(
    tlv(0xa0, smallInt(2)),      // version v3
    int(serial),
    seq(oid(OID.sha256WithRsa), nullTag()),
    issuer,
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    tlv(0xa3, extensions),       // [3] EXPLICIT Extensions
  );

  const signature = cryptoSign('sha256', tbs, privateKey);
  const cert = seq(tbs, seq(oid(OID.sha256WithRsa), nullTag()), bitStr(signature));

  const pem = (der, label) => `-----BEGIN ${label}-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END ${label}-----\n`;
  const certPem = pem(cert, 'CERTIFICATE');
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  return {
    certPem,
    keyPem,
    sha256: createHash('sha256').update(cert).digest('hex'),
  };
}

/* ── CLI ──────────────────────────────────────────────────────────────── */

const isMain = process.argv[1] && /make-cert\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const arg = (flag, fallback) => {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
  };
  const outDir = resolve(arg('--out', 'certs'));
  const cn = arg('--cn', 'localhost');
  const days = Number(arg('--days', 365));
  const extra = arg('--alt', '');
  const altNames = extra ? String(extra).split(',').map((s) => s.trim()).filter(Boolean) : [];

  const made = makeSelfSignedCert({ cn, days, altNames });
  mkdirSync(outDir, { recursive: true });
  const certFile = join(outDir, 'relay-cert.pem');
  const keyFile = join(outDir, 'relay-key.pem');
  writeFileSync(certFile, made.certPem, 'utf8');
  writeFileSync(keyFile, made.keyPem, 'utf8');

  console.log('自签证书已生成：');
  console.log(`  证书：${certFile}`);
  console.log(`  私钥：${keyFile}`);
  console.log(`  指纹：sha256=${made.sha256.slice(0, 32)}…`);
  console.log(`  主题：CN=${cn}${altNames.length ? `，SAN 还含 ${altNames.join('/')}` : ''}，有效期 ${days} 天`);
  console.log('');
  console.log('用法：');
  console.log(`  node tools/relay-server.mjs --port 8787 --host 0.0.0.0 --tls-cert "${certFile}" --tls-key "${keyFile}"`);
  console.log('');
  console.log('⚠️ 自签证书浏览器/客户端会报"不受信任"——这是自签的必然。');
  console.log("   局域网自用没问题；要让别人也放心用，请申请真证书（Let's Encrypt 免费）。");
  console.log('   ⚠️ 私钥是明文，别提交进仓库。');
}

export default { makeSelfSignedCert };
