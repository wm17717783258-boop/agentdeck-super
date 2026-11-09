#!/usr/bin/env node
/**
 * tools/pack-clean.mjs —— 打包前体检：别把不该发的东西发出去
 *
 * 为什么需要它：2026-11-07 那次交付包里带着 .secrets/gh.token（明文 GitHub 令牌）、
 *   21MB 未审计的 .tools/mcp-publisher.exe、还有一整份 internal/（定价红线、私钥路径、
 *   发码流程）。.gitignore 里写着不提交，但打包时没人拦——配置写了不等于流程生效。
 *
 * 这个脚本只做一件事：**检查**，不替用户删任何东西（删除是不可逆的，得人来按）。
 * 默认退出码非 0 时表示"不该发的目录/文件还在"，可以直接卡在 CI 或发版脚本里。
 *
 * 用法：
 *   node tools/pack-clean.mjs                 # 体检（只读），有风险项则退出码 1
 *   node tools/pack-clean.mjs --json          # 机器可读输出
 *   node tools/pack-clean.mjs --root <dir>    # 指定要体检的目录（默认仓库根）
 *   node tools/pack-clean.mjs --allowlist     # 额外打印 npm 白名单与实际的差集
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const argv = process.argv.slice(2);

function flagValue(name, fallback = '') {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const ROOT = resolve(flagValue('--root', PKG));
const AS_JSON = argv.includes('--json');
const WITH_ALLOWLIST = argv.includes('--allowlist');

/**
 * 规则表。每条说清"为什么不许发"——光写"禁止"没人看得懂为什么。
 * kind: 'path' 整棵目录；'glob' 按扩展名；'name' 按文件名。
 */
const RULES = [
  { id: 'secrets', kind: 'path', value: '.secrets', why: '凭据目录（gh.token 这类明文令牌）', severity: 'high' },
  { id: 'tools-bin', kind: 'path', value: '.tools', why: '本机下载的第三方可执行文件，仓库里不该有', severity: 'high' },
  { id: 'internal', kind: 'path', value: 'internal', why: '内部资料（定价 / 变现 / 竞品 / 发码流程），只留本地', severity: 'high' },
  { id: 'node-modules', kind: 'path', value: 'node_modules', why: '依赖，装的时候自己拉', severity: 'medium' },
  { id: 'dist', kind: 'path', value: 'dist', why: '构建产物，不该进源码包', severity: 'medium' },
  { id: 'issuer-keys', kind: 'glob', value: /^(?:issuer-|.*-private)\.pem$/i, why: '签发私钥：泄露后谁都能签永久授权', severity: 'high' },
  { id: 'pem', kind: 'glob', value: /\.pem$/i, why: '私钥/证书，除 assets 下的示例', severity: 'high' },
  { id: 'tarball', kind: 'glob', value: /\.tgz$/i, why: '打包产物，体积大且会和源码漂移', severity: 'medium' },
  { id: 'zip', kind: 'glob', value: /\.zip$/i, why: '压缩包，同上', severity: 'medium' },
  { id: 'sourcemap', kind: 'glob', value: /\.map$/i, why: '源码映射，不是发布必需', severity: 'low' },
  { id: 'envfile', kind: 'glob', value: /^\.env(?:\.|$)/i, why: '环境变量文件常含密钥', severity: 'high' },
  { id: 'token-file', kind: 'glob', value: /(?:^|\.)(?:token|secret|credential)s?$/i, why: '名字就叫令牌/密钥的文件', severity: 'high' },
  { id: 'log', kind: 'glob', value: /\.log$/i, why: '运行日志，可能含凭据与用户数据', severity: 'low' },
];

/** 明确允许的例外：assets 下的示例证书是皮肤规范的一部分。 */
const ALLOW = [
  /^assets\/.*\.pem$/i,
  /^assets\/skins\/.*/i,
  /^licenses\//i,
];

/**
 * 内容级规则：按**文件内容**找敏感信息，不是按文件名。
 *
 * 为什么必须有：文件名检查有个大盲区 —— `docs/evidence/*.txt` 这种验证日志
 * 名字完全正常，但里面可能原样记着真机测试时用的真实内网 IP
 * （例：192.168.31.39）和房间邀请令牌（`?room=...&t=<32位>`）。
 * 这些会随 npm 包（files 白名单里有 docs/）发给所有下载的人。
 *
 * 只扫文本类扩展名，跳过二进制；单文件超过 MAX_SCAN_BYTES 只读前一段，
 * 避免大日志拖慢体检。
 */
const CONTENT_RULES = [
  {
    id: 'private-lan-ip',
    why: '文件里含真实内网 IP（测试日志留痕），发布后暴露你的内网拓扑',
    severity: 'medium',
    test: (text) => {
      const ips = new Set();
      // 只抓私网段，公网 IP 不报；127.0.0.1 / 0.0.0.0 属正常示例，排除
      const re = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g;
      let m;
      while ((m = re.exec(text))) {
        // 明显的示例/占位写法不算泄露：192.168.1.10、10.0.0.9 这类
        // 出现在文档例子、测试夹具里是正常的，报出来只会淹没有效信号。
        if (isExampleIp(m[1])) continue;
        ips.add(m[1]);
      }
      return [...ips];
    },
  },
  {
    id: 'room-invite-token',
    why: '文件里含房间邀请令牌（进房凭证）；发布后任何人拿到就能进你的房间',
    severity: 'high',
    test: (text) => {
      const out = new Set();
      // 邀请形态：?room=<id>&t=<token> 或 t=<32位以上随机串>
      const re = /[?&]t=([A-Za-z0-9]{24,})/g;
      let m;
      while ((m = re.exec(text))) out.add(m[1].slice(0, 8) + '…');
      return [...out];
    },
  },
];

/**
 * 常见的"示例 IP"：文档举例、单测夹具里反复出现的固定网段。
 * 这些报出来是噪音，会让人开始忽略体检结果 —— 那比不报还糟。
 * 真实留痕通常带**具体的机器号**（如 192.168.31.39），跟这些示例区分得开。
 */
const EXAMPLE_IPS = new Set([
  '192.168.1.10', '192.168.1.1', '192.168.0.1', '192.168.1.100',
  '192.168.31.1', '10.0.0.1', '10.0.0.9', '10.0.0.2', '172.16.0.1',
  '192.168.13.1', // 常见虚拟网卡示例段
  '10.0.0.8',     // docs/transports.md 里 bridge.probe 的示例 url，不是真实机器
]);

function isExampleIp(ip) {
  return EXAMPLE_IPS.has(ip);
}

/** 体检脚本自身、以及它的规则说明里必然出现 IP 样例 —— 不自查。 */
const SELF_SKIP = new Set(['tools/pack-clean.mjs']);

/**
 * 不进 npm 包的目录：扫它们只会制造噪音。
 *
 * `verify-*` 是 `tools/verify-pack.mjs` 每次打包自建的快照目录（名字带版本），
 * 里面是**旧版本**的完整副本 —— 老版本里的历史 IP 留痕会被反复报出来，
 * 但它根本不会被发布。`.nexi-pair` / `.agentdeck` 是本地运行状态，
 * `.tmp-*` 是探针目录，同理。
 *
 * 注意：`.tools` **不**在这个名单里 —— 它是真风险（21MB 的 .exe 躺在那儿），
 * 必须被报出来让人决定删不删。
 */
const NO_PACK_DIRS = new Set(['.nexi-pair', '.agentdeck', '.git', '.cache']);
const NO_PACK_PREFIX = ['verify-', '.tmp-'];

function notPackaged(name) {
  if (NO_PACK_DIRS.has(name)) return true;
  return NO_PACK_PREFIX.some((p) => name.startsWith(p));
}

const SCAN_EXT = /\.(?:txt|md|json|jsonl|log|mjs|js|ts|yml|yaml|csv|html?)$/i;
const MAX_SCAN_BYTES = 512 * 1024;

function allowed(rel) {
  return ALLOW.some((re) => re.test(rel.replace(/\\/g, '/')));
}

function depthOf(rel) {
  return rel.split(/[\\/]/).length;
}

/**
 * 扫描。跳过被整棵目录命中的子树（命中 .secrets 就不必往里翻 1000 个文件）。
 * 返回 { findings, scanned, skippedDirs }
 */
function scan(root) {
  const findings = [];
  let scanned = 0;
  const skippedDirs = [];

  const hitPath = (name) => RULES.find((r) => r.kind === 'path' && r.value === name);
  const hitFile = (name) => RULES.find((r) => r.kind === 'glob' && r.value.test(name));

  const walk = (dir, depth) => {
    if (depth > 8) return; // 防病态深目录
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (allowed(rel)) continue;

      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        // 不进包的目录直接跳过，否则历史快照里的旧留痕会反复污染体检结果。
        if (notPackaged(name)) continue;
        const rule = hitPath(name);
        if (rule) {
          findings.push({
            rule: rule.id,
            path: rel,
            severity: rule.severity,
            why: rule.why,
            bytes: null,
            note: '整棵目录',
          });
          skippedDirs.push(rel);
          continue;
        }
        walk(full, depth + 1);
        continue;
      }

      scanned += 1;
      const rule = hitFile(name);
      if (rule) {
        findings.push({ rule: rule.id, path: rel, severity: rule.severity, why: rule.why, bytes: st.size, note: '' });
        continue; // 文件名已判风险，不必再读内容
      }

      // 内容级检查：文件名正常但内容可能含真实内网 IP / 邀请令牌。
      // 只对文本类扩展名、且不超过 MAX_SCAN_BYTES 的文件做。
      const relPosix = rel.replace(/\\/g, '/');
      if (!SELF_SKIP.has(relPosix) && SCAN_EXT.test(name) && st.size > 0 && st.size <= MAX_SCAN_BYTES) {
        let text = '';
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          text = '';
        }
        if (text) {
          for (const cr of CONTENT_RULES) {
            const hits = cr.test(text);
            if (hits.length) {
              findings.push({
                rule: cr.id,
                path: rel,
                severity: cr.severity,
                why: cr.why,
                bytes: st.size,
                note: `命中 ${hits.length} 处：${hits.slice(0, 3).join(', ')}${hits.length > 3 ? ' …' : ''}`,
              });
            }
          }
        }
      }
    }
  };

  walk(root, 0);
  return { findings, scanned, skippedDirs };
}

/** 顺手算一下"这些风险项有多大"，让用户知道删了能省多少。 */
function sizeOf(root, rel) {
  const full = join(root, rel);
  try {
    const st = statSync(full);
    if (!st.isDirectory()) return st.size;
    let total = 0;
    for (const name of readdirSync(full)) total += sizeOf(root, join(rel, name));
    return total;
  } catch {
    return 0;
  }
}

function human(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

const { findings, scanned, skippedDirs } = scan(ROOT);

const enriched = findings.map((f) => ({
  ...f,
  sizeBytes: sizeOf(ROOT, f.path),
}));
const high = enriched.filter((f) => f.severity === 'high');
const medium = enriched.filter((f) => f.severity === 'medium');
const low = enriched.filter((f) => f.severity === 'low');
const totalBytes = enriched.reduce((s, f) => s + f.sizeBytes, 0);

let allowlistNote = null;
if (WITH_ALLOWLIST) {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const files = Array.isArray(pkg.files) ? pkg.files : [];
    allowlistNote = {
      declared: files,
      missingFromAllowlist: RULES.filter((r) => r.kind === 'path').map((r) => r.value).filter((v) => !files.includes(v)),
      note: 'npm 的 files 白名单决定发什么；上面这些目录不在白名单里是好事（说明会被排除）。',
    };
  } catch {
    allowlistNote = { error: '读不到 package.json' };
  }
}

const result = {
  ok: high.length === 0,
  root: ROOT,
  scannedFiles: scanned,
  skippedDirs,
  counts: { high: high.length, medium: medium.length, low: low.length, total: enriched.length },
  reclaimableBytes: totalBytes,
  reclaimable: human(totalBytes),
  findings: enriched,
  allowlist: allowlistNote,
};

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const line = (f) => `  [${f.severity.toUpperCase()}] ${f.path}  (${human(f.sizeBytes)}) — ${f.why}`;
  console.log('打包前体检 —— 只检查，不替你做任何删除\n');
  console.log(`仓库根：${ROOT}`);
  console.log(`扫了 ${scanned} 个文件；整棵跳过的目录：${skippedDirs.length ? skippedDirs.join('、') : '（无）'}`);
  console.log('');
  if (!findings.length) {
    console.log('干净：没有发现不该发出去的东西。');
  } else {
    if (high.length) {
      console.log(`不适合外发（${high.length} 项，会造成真实损失）：`);
      high.forEach((f) => console.log(line(f)));
      console.log('');
    }
    if (medium.length) {
      console.log(`建议剔除（${medium.length} 项，体积/漂移问题）：`);
      medium.forEach((f) => console.log(line(f)));
      console.log('');
    }
    if (low.length) {
      console.log(`可以清理（${low.length} 项）：`);
      low.forEach((f) => console.log(line(f)));
      console.log('');
    }
    console.log(`合计可回收体积：${human(totalBytes)}`);
    console.log('');
    console.log('下一步（由你决定，脚本不代劳）：');
    console.log('  1) 高严重项先处理：凭据要作废重签，别只是删文件');
    console.log('  2) 再删目录，最后重跑一次本脚本确认干净');
  }
  if (allowlistNote && !allowlistNote.error) {
    console.log('');
    console.log('npm files 白名单与现状：');
    console.log(`  已声明：${allowlistNote.declared.join('、')}`);
    console.log(`  不在白名单（会被自动排除）：${allowlistNote.missingFromAllowlist.length ? allowlistNote.missingFromAllowlist.join('、') : '（无）'}`);
  }
}

process.exitCode = result.ok ? 0 : 1;
