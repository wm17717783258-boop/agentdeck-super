/**
 * 习惯进化实证：全走 MCP 网关（和 Claude / Codex 接进来时是同一条路）。
 *
 * 1) 建组 → 连续 3 个同类任务 → 逐个完成（宿主 emit → 桌宠记信号）
 * 2) twin_habit propose 看候选 → confirm 第一个
 * 3) twin_brief 里应该出现"用户确认过的习惯"
 *
 * 用法：node tools/drive-habit.mjs
 * 环境：演示宿主目录默认使用系统临时目录，换机器可用 NEXI_DEMO_ROOT 指过去。
 * 注意：这一步会往演示任务板真写组和任务，别对着你正在用的档案跑。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = process.env.NEXI_DEMO_ROOT || mkdtempSync(join(tmpdir(), 'nexi-habit-'));
const ownedRoot = !process.env.NEXI_DEMO_ROOT;
const env = {
  ...process.env,
  NEXI_WORKSPACE: join(ROOT, 'work'),
  NEXI_BOARD_ROOT: join(ROOT, 'board'),
  NEXI_PET_ROOT: join(ROOT, 'pet'),
  NEXI_LICENSE_ROOT: join(ROOT, 'board'),
};

const child = spawn(process.execPath, [join(REPO, 'bin', 'nexi.mjs'), 'mcp'], {
  cwd: REPO, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
let buf = '';
const pending = new Map();
let nextId = 1;
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderr += d; });
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let idx = buf.indexOf('\n');
  while (idx !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    idx = buf.indexOf('\n');
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  }
});
const rpc = (method, params) => {
  const id = nextId++;
  const payload = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时 ${method}`)), 20000);
    pending.set(id, (msg) => { clearTimeout(timer); resolvePromise(msg); });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  });
};
const call = async (name, args) => {
  const r = await rpc('tools/call', { name, arguments: args });
  const text = (r.result?.content || []).map((b) => b.text).join('\n');
  if (r.error) throw new Error(`${name} 报错：${JSON.stringify(r.error)}`);
  return text;
};
const show = (label, text) => console.log(`\n=== ${label} ===\n${text}`);

try {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'habit-demo', version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const created = await call('team_board', { action: 'create', name: '周报自动化', goal: '把每周的 sql 周报自动跑出来' });
  show('建组', created);
  const teamId = (created.match(/team_[0-9a-f]{6,}/i) || [null])[0];

  // 三次干的是同一类活（真实场景里就是每周跑一次），标签集合完全一致才会攒成习惯。
  const titles = ['跑 sql 周报', '跑 sql 周报', '跑 sql 周报'];
  const ids = [];
  for (const title of titles) {
    const text = await call('team_board', { action: 'add', teamId, title, acceptance: '跑通' });
    const m = text.match(/task_[a-z0-9]+/i);
    ids.push(m ? m[0] : null);
    show(`加任务：${title}`, text);
  }

  for (const id of ids) {
    if (!id) continue;
    show(`完成任务 ${id}`, await call('team_board', { action: 'done', teamId, taskId: id, output: '干完了' }));
  }

  const proposed = await call('twin_habit', { action: 'propose' });
  show('习惯候选', proposed);

  const keyMatch = proposed.match(/\[([^\]]+)\]/);
  if (keyMatch) {
    show('确认第一个候选', await call('twin_habit', { action: 'confirm', key: keyMatch[1] }));
    show('确认后再看候选', await call('twin_habit', { action: 'propose' }));
  } else {
    console.log('\n（这次没有候选可确认）');
  }

  show('记忆简报', await call('twin_brief', {}));
  show('再加一条偏好后的简报', await (async () => {
    await call('twin_remember', { text: '王冕：汇报先给结论，再给细节', type: 'preference', tags: ['汇报'] });
    return call('twin_brief', {});
  })());
} catch (err) {
  console.error('驱动失败：', err.message);
  console.error(stderr.slice(-1500));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  setTimeout(() => {
    child.kill();
    if (ownedRoot) rmSync(ROOT, { recursive: true, force: true });
  }, 300);
}
