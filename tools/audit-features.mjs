#!/usr/bin/env node
/**
 * tools/audit-features.mjs —— 功能对账：每个工具声明了什么动作，真调之后是不是真有反应
 *
 * 为什么要它：验收脚本能证明"命令没报错"，但不能证明"这个功能真的有用"。
 * 比如一个工具可能每次调用都返回"好的"但其实什么都没做——测试照样绿。
 *
 * 这里换一种验法：**给每个动作一个真实输入，然后去磁盘/状态里核对副作用**。
 *   写动作 → 写完必须读得到
 *   删动作 → 删完必须读不到
 *   读动作 → 必须返回非空且不是"不认识的动作"
 *
 * 用法：node tools/audit-features.mjs [--json]
 */

import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';

const AS_JSON = process.argv.includes('--json');
const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

/** 每个工具挑几个**真实会用到**的动作，给真实参数。 */
const PROBES = [
  { tool: 'team_board', action: 'create', args: { action: 'create', name: '对账小组' } },
  { tool: 'team_board', action: 'add', args: { action: 'add', title: '对账任务', acceptance: '能被读出来' } },
  { tool: 'team_board', action: 'list', args: { action: 'list' } },
  { tool: 'team_board', action: 'stats', args: { action: 'stats' } },
  { tool: 'twin_remember', action: '记住', args: { content: '对账用的一条记忆', type: 'event' } },
  { tool: 'twin_recall', action: '召回', args: { query: '对账' } },
  { tool: 'twin_brief', action: '简报', args: {} },
  { tool: 'twin_mandate', action: 'show', args: { action: 'show' } },
  { tool: 'twin_mandate', action: 'issue', args: { action: 'issue' } },
  { tool: 'twin_mandate', action: 'check', args: { action: 'check', tool: 'shell' } },
  { tool: 'pet_skin', action: 'list', args: { action: 'list' } },
  { tool: 'pet_skin', action: 'render', args: { action: 'render', id: 'basic', state: 'working' } },
  { tool: 'pet_visit', action: 'card', args: { action: 'card' } },
  { tool: 'pet_visit', action: 'invite', args: { action: 'invite', scope: 'work', ttlHours: 2 } },
  { tool: 'agent_passport', action: 'show', args: { action: 'show' } },
  { tool: 'agent_passport', action: 'issue', args: { action: 'issue', name: '对账卡', capabilities: ['team_board'] } },
  { tool: 'agent_passport', action: 'list', args: { action: 'list' } },
  { tool: 'deck_sync', action: 'info', args: { action: 'info' } },
  { tool: 'deck_license', action: 'status', args: { action: 'status' } },
  { tool: 'agent_join', action: 'list', args: { action: 'list' } },
  { tool: 'deck_team', action: 'status', args: { action: 'status' } },
  { tool: 'deck_meeting', action: 'list', args: { action: 'list' } },
  { tool: 'deck_automation', action: 'status', args: { action: 'status' } },
  { tool: 'deck_market', action: 'catalog', args: { action: 'catalog' } },
  { tool: 'deck_market', action: 'health', args: { action: 'health' } },
  { tool: 'deck_room', action: 'info', args: { action: 'info' } },
  { tool: 'deck_policy', action: 'show', args: { action: 'show' } },
  { tool: 'deck_policy', action: 'set', args: { action: 'set', rule: { id: 'audit-rule', match: { tool: 'deck_market' }, effect: 'deny', reason: '对账用' } } },
  // check 的参数是 tool + toolAction（不是嵌套对象）——第一次探针写错了，这里按真实签名给
  { tool: 'deck_policy', action: 'check', args: { action: 'check', tool: 'deck_market', toolAction: 'buy' } },
  { tool: 'deck_audit', action: 'tail', args: { action: 'tail', limit: 5 } },
  { tool: 'deck_audit', action: 'query', args: { action: 'query', limit: 5 } },
];

/** 这些动作是"写"：必须能在磁盘上找到痕迹。 */
const WRITE_ACTIONS = new Set([
  'team_board:create', 'team_board:add',
  'twin_remember:', 'twin_mandate:issue',
  'agent_passport:issue', 'deck_policy:set',
]);

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'nexi-audit-'));
  const boardRoot = join(root, 'board');
  const licenseRoot = join(root, 'lic');
  let hub = null;
  const rows = [];
  const sideEffects = [];

  try {
    hub = await createHub({ workspace: root, boardRoot, licenseRoot, onLog: () => {} });
    const tools = new Set(hub.list().map((t) => t.name));

    for (const p of PROBES) {
      if (!tools.has(p.tool)) {
        rows.push({ ...p, ok: false, why: '工具不存在', out: '' });
        continue;
      }
      let out = '';
      let threw = null;
      try {
        out = textOf(await hub.tools.get(p.tool).execute(p.args, { hub: true }));
      } catch (err) {
        threw = `${err?.name || 'Error'}: ${err?.message || err}`;
      }
      // 策略拒绝/执照拒绝不是"功能正常"，不能被当成有真实反应。
      // 只把"整条返回就是拒绝/确认拦截"判为失败；deck_policy 的说明文字里也会引用
      // 【策略拒绝】这几个字，不能因此把正常的规则写入误判成被拦截。
      const bad = /^(?:【策略拒绝】|【执照拒绝】|【需要确认】|【需要主人确认】)|不认识的动作|运行失败|错误：|失败：|需要.{0,6}参数/.test(out);
      rows.push({
        ...p,
        ok: !threw && !bad && out.length > 0,
        why: threw ? `抛错 ${threw}` : bad ? '返回了错误/不认识动作' : '',
        out: out.replace(/\s+/g, ' ').slice(0, 100),
      });
    }

    // 副作用核对：写动作之后，磁盘上必须真有东西
    const boardFiles = existsSync(boardRoot) ? readdirSync(boardRoot) : [];
    sideEffects.push({ what: '任务板状态文件', found: boardFiles.length > 0, detail: boardFiles.join(',') });

    const idDir = join(licenseRoot, '.agentdeck', 'identity');
    sideEffects.push({
      what: '身份密钥',
      found: existsSync(join(idDir, 'key.pem')),
      detail: existsSync(idDir) ? readdirSync(idDir).join(',') : '目录不存在',
    });

    const twinDir = join(root, '.agentdeck', 'twin');
    sideEffects.push({
      what: '分身记忆',
      found: existsSync(twinDir),
      detail: existsSync(twinDir) ? readdirSync(twinDir).join(',') : '目录不存在',
    });

    const petDir = join(root, '.agentdeck', 'pet');
    sideEffects.push({
      what: '桌宠档案',
      found: existsSync(petDir),
      detail: existsSync(petDir) ? readdirSync(petDir).join(',') : '目录不存在',
    });

    // 读回验证：写进去的任务能不能读出来
    const listed = textOf(await hub.tools.get('team_board').execute({ action: 'list' }, { hub: true }));
    const taskVisible = listed.includes('对账任务');
    sideEffects.push({ what: '写入的任务能读回', found: taskVisible, detail: taskVisible ? '对账任务 可见' : '读不到' });

    const recalled = textOf(await hub.tools.get('twin_recall').execute({ query: '对账' }, { hub: true }));
    const memVisible = recalled.includes('对账用的一条记忆');
    sideEffects.push({ what: '写入的记忆能召回', found: memVisible, detail: memVisible ? '可见' : '读不到' });
  } finally {
    try { await hub?.close(); } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true });
  }

  const okCount = rows.filter((r) => r.ok).length;
  const result = {
    tools: rows.length,
    ok: okCount,
    failed: rows.filter((r) => !r.ok),
    sideEffects,
    sideEffectsOk: sideEffects.filter((s) => s.found).length,
    sideEffectsTotal: sideEffects.length,
  };

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify({ ...result, rows }, null, 2)}\n`);
  } else {
    console.log('功能对账：每个动作真调一次，看它是不是真有用\n');
    console.log(`动作探针：${okCount}/${rows.length} 有真实反应`);
    for (const r of rows) {
      const mark = r.ok ? 'OK  ' : 'BAD ';
      console.log(`  ${mark} ${r.tool.padEnd(18)} ${String(r.action).padEnd(12)} ${r.why || r.out}`);
    }
    console.log('');
    console.log(`副作用核对：${result.sideEffectsOk}/${result.sideEffectsTotal} 有痕迹`);
    for (const s of sideEffects) {
      console.log(`  ${s.found ? 'OK  ' : 'BAD '} ${s.what.padEnd(18)} ${s.detail}`);
    }
    console.log('');
    console.log(result.failed.length ? `有 ${result.failed.length} 个动作没反应，需要查。` : '全部动作都有真实反应。');
  }
  process.exitCode = result.failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('对账脚本崩了：', err?.stack || err);
  process.exitCode = 2;
});
