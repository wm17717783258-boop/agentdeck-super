/**
 * tests/lan-tooling.test.mjs —— 多设备测试助手（nexi-lan.mjs）自己得先可靠
 *
 * 这个脚本是给"真机多设备"用的，它算错地址就等于把用户带沟里。
 * 所以这里验的是它的**判定逻辑**和**加入页真能用**：
 *   ① 地址排序：真局域网优先，虚拟网卡/回环垫底
 *   ② 只有回环时如实说"别的设备连不上"，不假装有局域网
 *   ③ 加入页真起得来、真能返回 HTML、真能自检中继
 *   ④ /handoff 给的纯文本说明能被复制走（手机不方便复制 shell 命令）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');
const SCRIPT = join(PKG, 'tools', 'nexi-lan.mjs');

/** 跑 --json 拿结构化结果。 */
function runJson(extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--json', ...extra], {
    cwd: PKG, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { status: r.status, json, stderr: r.stderr || '' };
}

test('--json 输出结构完整，且带上两台设备要用的信息', () => {
  const { status, json } = runJson();
  assert.equal(status, 0, '应该正常退出');
  assert.ok(json, '应该输出合法 JSON');
  assert.equal(json.ok, true);
  assert.ok(typeof json.relayUrl === 'string' && json.relayUrl.startsWith('http://'));
  assert.ok(typeof json.joinUrl === 'string' && json.joinUrl.startsWith('http://'));
  assert.ok(/^\d+$/.test(String(json.relayPort)), 'relayPort 应该是数字');
  assert.ok(/^[0-9A-F]{6}$/.test(String(json.token)), `配对码格式不对：${json.token}`);
  assert.ok(typeof json.handoff === 'string' && json.handoff.includes('配对码'), '应该给出可转发的说明');
});

test('地址排序：真局域网在虚拟网卡与回环之前', () => {
  const { json } = runJson();
  const addrs = json.addresses || [];
  assert.ok(Array.isArray(addrs));
  // 排完序之后：真实(rank0) -> 虚拟(rank50) -> 回环(rank100)
  for (let i = 1; i < addrs.length; i += 1) {
    assert.ok(addrs[i - 1].rank <= addrs[i].rank, '地址应按 rank 升序');
  }
  const firstReal = addrs.findIndex((a) => !a.internal && !a.virtual);
  const firstVirtual = addrs.findIndex((a) => a.virtual);
  const firstLoop = addrs.findIndex((a) => a.internal);
  if (firstReal >= 0 && firstVirtual >= 0) assert.ok(firstReal < firstVirtual, '局域网应排在虚拟网卡前面');
  if (firstReal >= 0 && firstLoop >= 0) assert.ok(firstReal < firstLoop, '局域网应排在回环前面');
});

test('选中的地址一定是"最该用的那个"，且如实标注能不能被别的设备连上', () => {
  const { json } = runJson();
  const best = json.best;
  assert.ok(best && typeof best.address === 'string');
  assert.ok(typeof best.why === 'string' && best.why.length > 0, '必须解释为什么选它');
  // hasRealLan 与 best 的判定必须自洽
  assert.equal(json.hasRealLan, !best.internal && !best.virtual);
  if (json.hasRealLan) {
    assert.ok(json.handoff.includes(best.address), '真实局域网地址应出现在转交说明里');
  }
});

test('虚拟网卡被判为 virtual（不冒充局域网）', () => {
  const { json } = runJson();
  for (const a of json.addresses || []) {
    if (/vmnet|vbox|wsl|docker|hyper-v|loopback|virtual/i.test(a.iface)) {
      assert.equal(a.virtual, true, `${a.iface} 应被标为虚拟网卡（当前 ${a.virtual}）`);
    }
  }
});

test('回环地址被判为 internal（别的设备连不上）', () => {
  const { json } = runJson();
  for (const a of json.addresses || []) {
    if (a.address.startsWith('127.')) {
      assert.equal(a.internal, true, '127.x 必须标为仅本机');
    }
  }
});

test('加入页真起得来、真返回 HTML（手机浏览器能打开的形态）', async () => {
  // 用一个高位随机端口，避免和真在跑的实例撞
  const port = 19000 + Math.floor(Math.random() * 500);
  // --serve 是常驻进程，所以异步起子进程 → 从外部真请求 → 最后杀掉。
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [SCRIPT, '--serve', '--port', String(port)], {
    cwd: PKG, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });

  /** 等加入页起来（最多 8 秒）。 */
  async function waitUp() {
    for (let i = 0; i < 40; i += 1) {
      await new Promise((res) => setTimeout(res, 200));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) return await res.json();
      } catch {
        // 还没起来，继续等
      }
    }
    return null;
  }

  try {
    const health = await waitUp();
    assert.ok(health, `加入页没起来（端口 ${port}）`);
    assert.equal(health.ok, true);
    assert.ok(/^[0-9A-F]{6}$/.test(health.token), 'healthz 应回配对码');
    assert.ok(String(health.relay).startsWith('http://'), 'healthz 应回中继地址');

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    const html = await page.text();
    assert.match(html, /Nexi 灵犀/, '应该是加入页');
    assert.match(html, /测试连接/, '应该有连通性自检按钮');
    assert.match(html, /加入测试|多设备测试/, '应该说明这是加入页');
    assert.ok(html.includes(health.token), '页面上应显示配对码');

    const handoff = await fetch(`http://127.0.0.1:${port}/handoff`);
    assert.equal(handoff.status, 200);
    const text = await handoff.text();
    assert.match(text, /配对码/, '纯文本说明应含配对码');
    assert.match(text, /deck_room/, '纯文本说明应含进房命令');
    assert.match(text, /inviteUrl/, '进房命令必须使用 deck_room 的真实参数 inviteUrl');
    assert.doesNotMatch(text, /\\"url\\":/, '进房命令不得再使用不存在的 url 参数');

    assert.match(html, /inviteUrl/, '加入页的进房命令必须使用 inviteUrl');
    assert.doesNotMatch(html, /\\"url\\":/, '加入页的进房命令不得再使用不存在的 url 参数');

    const notFound = await fetch(`http://127.0.0.1:${port}/whatever`);
    assert.equal(notFound.status, 404);
  } finally {
    child.kill();
    // 给它一点时间退出，然后强杀兜底
    await new Promise((res) => setTimeout(res, 300));
    try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
  }
});
