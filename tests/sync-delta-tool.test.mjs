/**
 * tests/sync-delta-tool.test.mjs —— deck_sync 的增量动作真的接上了吗
 *
 * lib/sync/delta.js 单测证明引擎算得对；这里证明**工具层真调得到它**。
 * 顺带钉住：增量动作在只读模式下也算写（它会推进游标），必须被拦。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHub } from '../lib/hub.js';
import { isReadonlyAllowed } from '../lib/mcp/readonly.js';

const textOf = (v) => String(v && typeof v === 'object' ? v.text ?? '' : v ?? '');

async function withHub(fn) {
  const root = mkdtempSync(join(tmpdir(), 'adsk-deltatool-'));
  const hub = await createHub({ workspace: root, boardRoot: join(root, 'b'), licenseRoot: join(root, 'l'), onLog: () => {} });
  try {
    return await fn(hub, root);
  } finally {
    try { await hub.close(); } catch { /* 忽略 */ }
    rmSync(root, { recursive: true, force: true });
  }
}

test('deck_sync 认识 delta 这个动作', async () => {
  await withHub(async (hub) => {
    const out = textOf(await hub.tools.get('deck_sync').execute({ action: 'delta' }, { hub: true }));
    assert.doesNotMatch(out, /不认识的动作/, `应该认识 delta：${out.slice(0, 200)}`);
    assert.match(out, /增量|游标|变化/, `应给增量报告：${out.slice(0, 250)}`);
  });
});

test('delta 动作返回游标信息（用户能看出同步进度）', async () => {
  await withHub(async (hub) => {
    const out = textOf(await hub.tools.get('deck_sync').execute({ action: 'delta' }, { hub: true }));
    assert.match(out, /游标|推送|已推|进度/, `应包含游标信息：${out.slice(0, 300)}`);
  });
});

test('只读模式下 delta 被拒（它会推进游标 = 写状态）', () => {
  assert.equal(
    isReadonlyAllowed('deck_sync', { action: 'delta' }),
    false,
    'delta 会写游标文件，只读模式下必须拒',
  );
});

test('deck_sync 描述里列出 delta（用户能发现这个能力）', async () => {
  await withHub(async (hub) => {
    const def = hub.tools.get('deck_sync');
    assert.match(String(def.description || ''), /delta/, '工具描述里应提到 delta');
  });
});
