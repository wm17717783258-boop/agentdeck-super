#!/usr/bin/env node
/**
 * tools/audit-requirements.mjs —— 原始需求逐条对账
 *
 * 为什么要它：功能对账（audit-features）证明"每个工具真有用"，
 * 但不能回答"用户当初要的那件事到底做到了没有"。
 *
 * 这个脚本把你的原始要求逐条拆开，每条给出：
 *   做到了 / 部分做到 / 没做到
 *   + 证据在哪（代码、测试、验收文件）
 *   + 边界是什么（没做到的那部分如实写）
 *
 * 用法：node tools/audit-requirements.mjs [--md]
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const AS_MD = process.argv.includes('--md');

/** 检查一堆文件里有没有存在的（用来当"证据在不在"的判据）。 */
function anyExists(rels) {
  return rels.filter((r) => existsSync(join(PKG, r)));
}

function evidenceDirHas(prefix) {
  const dir = join(PKG, 'docs', 'evidence');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(prefix));
}

/**
 * 原始需求 → 实现证据 → 判定。
 * status: 'done'（真做到并有证据）/ 'partial'（做到了但有边界）/ 'todo'（还没做）
 */
const REQUIREMENTS = [
  {
    req: '打破 Agent 之间的孤岛',
    status: 'done',
    how: 'agent_join 支持 5 种接入：本机 CLI、ACP-HTTP、OpenAI 兼容、CDP 桌面、ADBP 自研协议',
    evidence: ['lib/engine/cli.js', 'lib/engine/bridge.js', 'lib/engine/adbp.js', 'tests/cli.test.mjs', 'tests/bridge.test.mjs', 'tests/adbp.test.mjs'],
    boundary: '接入层和调度层有真实进程/协议测试；8 个宿主适配器都存在，但本机真认证只有 Codex 1 个，其余 7 个未安装。M4 里的 claude/codex/dsh 是三条独立 MCP 客户端身份，不等于三家厂商 CLI 都在本机真跑。',
  },
  {
    req: '打破人与人之间的孤岛',
    status: 'done',
    how: 'deck_room 跨机房间：房主建、客人凭邀请进（不需要授权码）',
    evidence: ['lib/room.js', 'tools/relay-server.mjs', 'tests/room-two-hosts.test.mjs'],
    evidenceFiles: ['twomachines', 'crosshost'],
    boundary: '房间成员默认互信（同团队场景），不是多租户隔离',
  },
  {
    req: 'Agent 之间真实协作（不只是能连上）',
    status: 'done',
    how: 'team_orchestrate 拆 DAG + 角色分工 + 验收门；team_board 抢占式认领',
    evidence: ['lib/engine/roles.js', 'lib/engine/board.js', 'tests/roles.test.mjs', 'tests/board.test.mjs'],
    boundary: '协作质量取决于接入的模型；调度逻辑本身是确定性的',
  },
  {
    req: '人与人真实协作',
    status: 'done',
    how: 'deck_team 团队空间（角色/席位/共享记忆）+ 与房间绑定',
    evidence: ['lib/team/space.js', 'tests/team-space.test.mjs'],
    boundary: 'SSO / SCIM / 私有化部署标注为「未实现」，没假装支持',
  },
  {
    req: '桌宠 = 可由用户自己制作的数字分身',
    status: 'partial',
    how: '三层开放：外观（skin.json）、人格（persona.json）、技能（skill.json），都放本地目录即可加载',
    evidence: ['lib/pet/skins.js', 'lib/pet/persona.js', 'tests/persona.test.mjs', 'tests/pet-skins.test.mjs'],
    boundary: '人格/技能是本地 JSON，需要用户自己写或导入；还没有图形化编辑器',
  },
  {
    req: '分身学习用户习惯并进化',
    status: 'partial',
    how: 'twin 记忆（5 类 × 4 级可见性 × 作用域 × TTL）+ 习惯学习（重复 3 次升习惯，置信度上限 0.95）',
    evidence: ['lib/twin/memory.js', 'lib/twin/context.js', 'lib/pet/profile.js', 'tests/twin.test.mjs', 'tests/pet-profile.test.mjs'],
    boundary: '是**统计出来的习惯**，不是机器学习式的"进化"；不学"怎么干活"，只学"什么时候干什么"',
  },
  {
    req: '用户不在线时，分身在授权范围内替用户执行任务',
    status: 'partial',
    how: 'deck_automation 定时/审批/重试/每日上限 + twin_mandate 执照限定自主范围 + nexi-daemon 常驻进程',
    evidence: ['lib/automation/runner.js', 'lib/twin/mandate.js', 'lib/tools/mandate.js', 'tools/nexi-daemon.mjs', 'tests/mandate.test.mjs', 'tests/mandate-wiring.test.mjs'],
    boundary: '常驻进程要用户自己挂（提供了 Windows 计划任务命令）；**托管分身（云上 24h）还没上线**，只有本地常驻',
  },
  {
    req: '分身可以代表用户去协作、串门',
    status: 'done',
    how: 'pet_visit（Ed25519 邀请 + X25519/AES-256-GCM 加密便签）+ pet_meeting（多分身开会→决议落成任务）',
    evidence: ['lib/pet/visit.js', 'lib/pet/e2ee.js', 'lib/pet/meeting.js', 'tests/pet-visit.test.mjs', 'tests/e2ee.test.mjs'],
    evidenceFiles: ['visit-2user'],
    boundary: '串门靠人传链接（没有自动同步）；便签加密不防中间人（匿名密钥交换）',
  },
  {
    req: '适配所有主流 Agent',
    status: 'partial',
    how: '8 个宿主适配器 + MCP 双通路（stdio + Streamable HTTP）+ OpenAPI 3.1 + A2A',
    evidence: ['lib/connect/hosts.js', 'lib/mcp/server.js', 'lib/mcp/http.js', 'lib/gateway/a2a.js'],
    evidenceFiles: ['hosts-'],
    boundary: '本机真认证只有 Codex 1 个（装→宿主自报→卸→逐字节还原）；其余 7 个未安装且拒绝伪造配置。协议适配齐全不等于 8 家厂商都已在真机认证。',
  },
  {
    req: '不分网络（断网也能用）',
    status: 'done',
    how: '本地功能全部离线；跨机房间不可用时优雅降级，不挂死',
    evidence: ['tools/verify-recovery.mjs', 'lib/room.js'],
    evidenceFiles: ['recovery-'],
    boundary: '跨公网推荐上 HTTPS（relay 支持 --tls-cert/--tls-key）',
  },
  {
    req: '不分地域（跨机）',
    status: 'done',
    how: 'relay 可自建可托管；两台机器走局域网/公网都能连',
    evidence: ['tools/relay-server.mjs'],
    evidenceFiles: ['twomachines', 'crosshost'],
    boundary: '托管 relay 还没上线（代码在，部署要自己做）',
  },
  {
    req: '不分设备（多设备同一份身份/记忆）',
    status: 'partial',
    how: 'deck_sync 支持全量加密打包/导入，也支持 action=delta 按游标只传变化；身份与授权跟人走（机级目录）',
    evidence: ['lib/sync/index.js', 'lib/sync/delta.js', 'lib/tools/sync.js', 'tests/sync.test.mjs', 'tests/sync-delta.test.mjs'],
    boundary: '增量同步已有，但没有自动发现/自动连接（怎么找到对面仍由调用方给地址）；冲突策略不是 CRDT',
  },
  {
    req: '不分 Agent（谁的 Agent 都能进同一张板）',
    status: 'done',
    how: '同一个 team_board，成员可来自任何接入方式；ADBP 协议任意语言 20 行接入',
    evidence: ['lib/engine/adbp.js', 'docs/transports.md', 'tests/adbp.test.mjs'],
    boundary: '自研 Agent 要自己实现 ADBP 的 4 个路由',
  },
  {
    req: '开源与闭源双轨（可自建，也有付费点）',
    status: 'done',
    how: '核心 AGPL-3.0 + 适配器 Apache-2.0；付费只在服务端（云房间/额度），本地能力永不锁',
    evidence: ['LICENSING.md', 'lib/license.js', 'lib/hosting/index.js'],
    boundary: '本地授权码可被改代码绕过（设计已知，所以收费点放服务端）',
  },
  {
    req: '能获得收入',
    status: 'partial',
    how: '发码链路完整（license-cli 签码/验码/记账）；托管 API 已挂进 relay（激活/用量/配额）；市场支持 80/20 分成',
    evidence: ['tools/license-cli.mjs', 'lib/hosting/index.js', 'lib/market/split.js', 'tests/hosting.test.mjs'],
    boundary: '**没有真实商户号，没验真扣款**；本地真 HTTP 网关（53/53）和 Stripe 形状适配器（26/26）只证明代码路径。官方托管服务未部署，目前收入仍靠手工发码/自建 relay。',
  },
];

const ICON = { done: 'YES ', partial: 'PART', todo: 'TODO' };
const LABEL = { done: '已做到', partial: '部分做到', todo: '没做到' };

const rows = REQUIREMENTS.map((r) => {
  const codeOk = anyExists(r.evidence || []);
  const evidenceFiles = (r.evidenceFiles || []).flatMap((p) => evidenceDirHas(p));
  return { ...r, codeOk, evidenceCount: codeOk.length, evidenceFiles };
});

const done = rows.filter((r) => r.status === 'done').length;
const partial = rows.filter((r) => r.status === 'partial').length;
const todo = rows.filter((r) => r.status === 'todo').length;

if (AS_MD) {
  const md = [];
  md.push('# 原始需求对账表');
  md.push('');
  md.push(`合计 ${rows.length} 条：已做到 ${done}，部分做到 ${partial}，没做到 ${todo}`);
  md.push('');
  md.push('| 需求 | 判定 | 怎么实现的 | 边界（没做到的那部分） |');
  md.push('| --- | --- | --- | --- |');
  for (const r of rows) {
    md.push(`| ${r.req} | ${LABEL[r.status]} | ${r.how} | ${r.boundary} |`);
  }
  process.stdout.write(`${md.join('\n')}\n`);
} else {
  console.log('原始需求对账\n');
  console.log(`合计 ${rows.length} 条：已做到 ${done}，部分做到 ${partial}，没做到 ${todo}\n`);
  for (const r of rows) {
    console.log(`[${ICON[r.status]}] ${r.req}`);
    console.log(`        实现：${r.how}`);
    console.log(`        证据：代码 ${r.evidenceCount} 个${r.evidenceFiles.length ? ` + 验收文件 ${r.evidenceFiles.length} 份` : ''}`);
    console.log(`        边界：${r.boundary}`);
    console.log('');
  }
}

process.exitCode = todo ? 1 : 0;
