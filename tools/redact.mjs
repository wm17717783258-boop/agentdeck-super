#!/usr/bin/env node
/**
 * tools/redact.mjs —— 发布前脱敏
 *
 * 为什么需要这个：`package.json` 的 files 白名单里有 `docs/`，而 `docs/evidence/`
 * 下 200+ 份真机验收日志是**边测边写**的，里面原样记着测试机的真实内网 IP
 * 和派活邀请令牌。这些会随 npm 包发给每一个下载的人。
 *
 * 体检（tools/pack-clean.mjs）只负责**发现**，这个脚本负责**修**。
 * 两者用同一套口径：替换成 EXAMPLE_IPS 里已有的示例值，改完再跑体检应当归零。
 *
 * 用法：
 *   node tools/redact.mjs --dry-run     # 只看会改什么（默认）
 *   node tools/redact.mjs --apply       # 真改
 *   node tools/redact.mjs --apply --root <dir>
 *
 * 设计取舍：
 *   · **只改文本类文件**，二进制一律跳过（改坏图片/证书是灾难）；
 *   · 用 UTF-8 读写并保留原编码 BOM 有无，避免中文文档被改乱；
 *   · 每处替换都打印「文件:行 + 原值 → 新值」，改了什么可复核、可回滚（git diff）；
 *   · 令牌只脱敏末尾，保留前 6 位 —— 万一是真实 token，你能认出是哪一个。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const rootIdx = args.indexOf('--root');
const ROOT = rootIdx >= 0 && args[rootIdx + 1] ? args[rootIdx + 1] : process.cwd();

/** 文本类扩展名：只在这几类文件里做替换。 */
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.jsonl', '.log', '.mjs', '.js', '.ts',
  '.yml', '.yaml', '.csv', '.html', '.htm', '.toml', '.ini',
]);

/**
 * 真实内网 IP 的**识别规则**（不写具体地址 —— 把真实 IP 写进这个文件本身
 * 就又是一次泄露，`tools/` 是会被打进包的）。
 *
 * 做法：按网段把私网地址归一到对应的示例地址。这样：
 *   · 源码里没有任何真实地址；
 *   · 以后换机器/换网段也不用改这个脚本；
 *   · 归一化后正好落在 pack-clean 的 EXAMPLE_IPS 白名单里，复核应当归零。
 */
const PRIVATE_IP_RE = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;

/** 已经是「示例地址」的，原样保留（否则跑第二遍会不断改写）。 */
const EXAMPLE_IPS = new Set([
  '192.168.1.10', '192.168.1.1', '192.168.0.1', '192.168.1.100',
  '192.168.31.1', '10.0.0.1', '10.0.0.9', '10.0.0.2', '172.16.0.1',
  '192.168.13.1', '10.0.0.8',
]);

/** 每个网段统一归一到一个固定的示例地址。 */
function exampleFor(ip) {
  if (ip.startsWith('10.')) return '10.0.0.1';
  if (ip.startsWith('172.')) return '172.16.0.1';
  return '192.168.1.10';
}

/** 邀请令牌：`t=<24位以上>` → 保留前 6 位 + <redacted>。 */
const TOKEN_RE = /([?&]t=)([A-Za-z0-9]{24,})/g;

/**
 * 不扫的目录：把体检自己的白名单、以及明显的产物目录排除。
 *
 * 后三类是本仓库特有的「本地产物」——它们**不会**进 npm 包
 * （`package.json` 的 files 白名单没列、或者以 `.` 开头默认被 npm 忽略），
 * 在里面做脱敏纯属浪费，还会把「改了 29 个文件」这种噪音报给用户。
 *
 * `.tools` 保留扫描：它虽然也不进包，但里面装着 21MB 的二进制，
 * 是体检应该报给人的真风险，脱敏时顺手看一眼没坏处。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage',
  '.nexi-pair', '.agentdeck', '.cache',
]);

/**
 * 目录名前缀黑名单：`verify-1.11.4-final2/` 这类一次性验证目录
 * （`tools/verify-pack.mjs` 每次打包都会新建一个，名字带版本或序号）。
 * 它们同样不进包，没必要脱敏。
 */
const SKIP_PREFIX = ['verify-', '.tmp-'];

function shouldSkipDir(name) {
  if (SKIP_DIRS.has(name)) return true;
  return SKIP_PREFIX.some((p) => name.startsWith(p));
}

/** 检测器/脱敏器自身：规则说明里必然含示例 IP，不该被自己改。 */
const SELF_SKIP = new Set(['tools/pack-clean.mjs', 'tools/redact.mjs']);

const changes = [];
let scanned = 0;
let skippedBinary = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (shouldSkipDir(ent.name)) continue;
      walk(full);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = extname(ent.name).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    scanFile(full);
  }
}

function scanFile(full) {
  let buf;
  try {
    buf = readFileSync(full);
  } catch {
    return;
  }
  // 二进制嗅探：前 8KB 里出现 NUL 就当二进制，跳过
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) {
    skippedBinary += 1;
    return;
  }
  scanned += 1;
  const text = buf.toString('utf8');
  let next = text;
  const rel = relative(ROOT, full).replace(/\\/g, '/');
  if (SELF_SKIP.has(rel)) return;

  // ① 真实内网 IP：按网段归一到示例地址
  const ipHits = [];
  const ipSeen = new Set();
  next = next.replace(PRIVATE_IP_RE, (m) => {
    if (EXAMPLE_IPS.has(m)) return m;
    ipSeen.add(m);
    const lineNo = next.slice(0, next.indexOf(m)).split('\n').length;
    ipHits.push({ line: lineNo, snippet: m });
    return exampleFor(m);
  });
  if (ipHits.length) {
    changes.push({
      rel, kind: 'private-lan-ip',
      from: [...ipSeen].join(', '),
      to: [...ipSeen].map(exampleFor).join(', '),
      count: ipHits.length, samples: ipHits.slice(0, 2),
    });
  }

  // ② 邀请令牌
  const tokenHits = [];
  next = next.replace(TOKEN_RE, (m, prefix, token) => {
    const lineNo = next.slice(0, next.indexOf(m)).split('\n').length;
    tokenHits.push({ line: lineNo, snippet: `${token.slice(0, 6)}…（${token.length} 位）` });
    return `${prefix}${token.slice(0, 6)}<redacted>`;
  });
  if (tokenHits.length) {
    changes.push({
      rel, kind: 'room-invite-token', from: `${tokenHits.length} 个令牌`, to: '前6位<redacted>',
      count: tokenHits.length, samples: tokenHits.slice(0, 3),
    });
  }

  if (next !== text && APPLY) writeFileSync(full, next, 'utf8');
}

walk(ROOT);

const total = changes.reduce((n, c) => n + c.count, 0);
console.log(`扫描 ${scanned} 个文本文件（跳过 ${skippedBinary} 个二进制）`);
console.log(`命中 ${changes.length} 个文件 / ${total} 处\n`);

if (!changes.length) {
  console.log('✅ 没发现需要脱敏的内容。');
  process.exit(0);
}

for (const c of changes) {
  console.log(`${c.rel}`);
  console.log(`  ${c.kind}: ${c.from} → ${c.to}  (${c.count} 处)`);
  for (const s of c.samples) {
    console.log(`    第 ${s.line} 行: ${s.snippet}`);
  }
}

console.log('');
if (APPLY) {
  console.log(`✅ 已写入 ${changes.length} 个文件。建议下一步：node tools/pack-clean.mjs 复核应归零。`);
} else {
  console.log('（干跑，未改文件）加 --apply 才会真改。');
}
