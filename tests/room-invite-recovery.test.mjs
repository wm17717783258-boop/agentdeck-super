/**
 * tests/room-invite-recovery.test.mjs —— 从邀请链接里自动认出中继地址
 *
 * 真机踩到的坑：房主给的是「网页加入页」形态的链接
 *   http://192.168.1.10:8787/?room=xxx&t=yyy
 * 地址明明在链接里，guest 却报"还没有配置 relay 地址"——因为 join 时
 * ensure() 先跑了，那时还没解析链接。修完之后必须钉住这条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

async function withHub(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-roominv-'));
  const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
  try {
    return await fn(hub);
  } finally {
    try { await hub.close(); } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true });
  }
}

test('网页加入页形态的链接：不再报"没有配置 relay 地址"', async () => {
  await withHub(async (hub) => {
    // 用本机已关闭端口代替 TEST-NET 地址：同样能验出"这是网络错误"，但不会让
    // Windows 在某些网络配置下等几十秒才返回，避免全量测试被外部网络状态拖慢。
    const url = 'http://127.0.0.1:1/?room=test-room-1&t=tok123';
    const out = textOf(await hub.tools.get('deck_room').execute({ action: 'join', inviteUrl: url }, { hub: true }));
    // 关键：不该再出现"还没有配置 relay 地址"，因为地址就在链接里
    assert.ok(
      !/没有配置 relay 地址|还没有配置 relay/.test(out),
      `没能从链接里认出中继地址：${out.slice(0, 200)}`,
    );
    // 会真的去连（连不上是正常的，因为本机 1 端口没有服务），
    // 但报错应该是"连不上/超时"这类**网络**问题，不是"没配地址"
    assert.match(out, /进房间|连接|失败|超时|不可达|ECONN|fetch/i, `输出不像网络错误：${out.slice(0, 200)}`);
  });
});

test('dsh:// 深链抠不出 http 地址（靠 relayUrl 参数兜底）', async () => {
  await withHub(async (hub) => {
    const out = textOf(await hub.tools.get('deck_room').execute(
      { action: 'join', inviteUrl: 'dsh://agentdeck/join?room=r1&t=tok' },
      { hub: true },
    ));
    // 深链没有 http 地址，所以这里应该提示没配 relay（这是**正确**行为）
    assert.match(out, /没有配置 relay|还没有配置 relay/, `深链应当提示缺 relay：${out.slice(0, 200)}`);
  });
});

test('dsh:// 深链 + 显式 relayUrl：地址由参数提供', async () => {
  await withHub(async (hub) => {
    const out = textOf(await hub.tools.get('deck_room').execute(
      { action: 'join', inviteUrl: 'dsh://agentdeck/join?room=r1&t=tok', relayUrl: 'http://127.0.0.1:1' },
      { hub: true },
    ));
    assert.ok(!/没有配置 relay|还没有配置 relay/.test(out), `relayUrl 参数应该生效：${out.slice(0, 200)}`);
  });
});

test('显式 relayUrl 优先于链接里的地址（用户能覆盖）', async () => {
  await withHub(async (hub) => {
    // 链接里写 A 地址，参数里给 B —— 应该用 B（显式优先）
    const out = textOf(await hub.tools.get('deck_room').execute(
      {
        action: 'join',
        inviteUrl: 'http://192.0.2.1:1111/?room=r1&t=tok',
        relayUrl: 'http://127.0.0.1:59999',
      },
      { hub: true },
    ));
    // 127.0.0.1:59999 上什么都没有，报错里不该出现 192.0.2.1
    assert.ok(!out.includes('192.0.2.1'), `应该用显式 relayUrl，但输出里出现了链接里的地址：${out.slice(0, 200)}`);
  });
});

test('relayUrl 覆盖是"一次性的"，不会污染后续调用', async () => {
  await withHub(async (hub) => {
    // 第一次带 relayUrl
    await hub.tools.get('deck_room').execute(
      { action: 'join', inviteUrl: 'dsh://agentdeck/join?room=r1&t=tok', relayUrl: 'http://127.0.0.1:1' },
      { hub: true },
    );
    // 第二次不带，且用 dsh 深链（本身不含地址）→ 应该回到"没配 relay"
    const second = textOf(await hub.tools.get('deck_room').execute(
      { action: 'join', inviteUrl: 'dsh://agentdeck/join?room=r2&t=tok2' },
      { hub: true },
    ));
    assert.match(second, /没有配置 relay|还没有配置 relay/, `上一次的 relayUrl 不该残留：${second.slice(0, 200)}`);
  });
});
