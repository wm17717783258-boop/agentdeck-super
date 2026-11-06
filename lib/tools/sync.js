/**
 * `deck_sync` —— 跨设备同步（加密 Sync）
 *
 * 蓝图里点名三次的能力：07 模块「跨设备、云长期记忆」付费触发点、
 * 能力表 Payment Hook、架构图「Encrypted Sync：跨设备 · 备份 · 恢复」。
 *
 * 用法：
 *   pack    —— 把本机"你的东西"（记忆/习惯/自动化/皮肤/策略）打包成一个口令加密的字符串
 *   apply   —— 在另一台设备上贴进来，解密并**合并**（不是覆盖）
 *   info    —— 看本机有哪些东西会被带走、设备指纹是什么
 *
 * 诚实边界：口令丢了就真解不开（没有找回、没有后门）；这是特性。
 */

import { normalizeDeps, safeExecute, TOOL_OUTPUT } from './common.js';
import { applySnapshot, collectSnapshot, deviceId, packSync, unpackSync } from '../sync/index.js';

const ACTIONS = ['pack', 'apply', 'info'];

export function createSyncTool(deps) {
  const d = normalizeDeps(deps || {});
  const rootOf = () => {
    const v = d.root ? d.root() : '';
    return String(v || process.cwd());
  };

  return {
    name: 'deck_sync',
    description: [
      '跨设备同步：把本机属于你的东西（分身记忆、习惯、自动化规则、皮肤装备、动作策略）',
      '用一个**你自己的口令**加密打包，在另一台设备上解密合并。',
      'pack=导出加密串（默认）；apply=把对方给的串合并进来；info=看会带走什么。',
      '服务器/中转方只看到密文——这是端到端的，不是"我们承诺不看"。',
      '口令至少 6 位；**丢了就真解不开**，没有找回、没有后门。',
      '不含授权码与身份私钥（那两样不该跨设备明文搬运）。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'pack=导出（默认）；apply=合并进来；info=看清单。' },
        passphrase: { type: 'string', description: 'pack/apply：你自己的口令（至少 6 位）。丢了就解不开。' },
        blob: { type: 'string', description: 'apply：对方给你的那段加密串（NEXISYNC1. 开头）。' },
      },
      required: [],
    },
    output: TOOL_OUTPUT,
    execute: safeExecute('deck_sync', async (args) => {
      const action = String(args.action || 'pack').toLowerCase();
      if (!ACTIONS.includes(action)) {
        return `【deck_sync】不认识的动作 "${action}"。可用：${ACTIONS.join('、')}。`;
      }

      if (action === 'info') {
        const got = collectSnapshot({ root: rootOf() });
        if (!got.ok) return `【deck_sync】${got.reason}`;
        const c = got.counts;
        return [
          '【deck_sync】本机会被带走的东西：',
          `· 分身记忆 ${c.memory} 条`,
          `· 确认过的习惯 ${c.habits} 条`,
          `· 自动化规则 ${c.jobs} 条`,
          `· 动作策略 ${c.rules} 条`,
          `· 桌宠皮肤：${got.snapshot.pet.skin || '（还没换过）'}`,
          '',
          `设备指纹：${deviceId({ root: rootOf() })}`,
          '不带走的：授权码、身份私钥、任务板内容（那些要么是凭据、要么属于小组）。',
          '',
          '导出：action:"pack"，passphrase:"你的口令"。',
        ].join('\n');
      }

      if (action === 'pack') {
        const pass = String(args.passphrase || '');
        if (pass.length < 6) return '【deck_sync】口令至少 6 位——太短等于没加密。';
        const got = packSync({ root: rootOf(), passphrase: pass });
        if (!got.ok) return `【deck_sync】打包失败：${got.reason}`;
        const c = got.counts;
        return [
          `【deck_sync】已打包（记忆 ${c.memory} · 习惯 ${c.habits} · 自动化 ${c.jobs} · 策略 ${c.rules}）`,
          '把下面整段发到另一台设备，在那边用 action:"apply" + 同一个口令贴进来：',
          '',
          got.blob,
          '',
          '⚠️ 口令丢了这段就永远解不开——没有找回功能。',
        ].join('\n');
      }

      // apply
      const pass = String(args.passphrase || '');
      const blob = String(args.blob || '').trim();
      if (!blob) return '【deck_sync】apply 需要 blob（对方给你的那段加密串）。';
      if (!pass) return '【deck_sync】apply 需要 passphrase（跟导出时同一个口令）。';

      const opened = unpackSync({ blob, passphrase: pass });
      if (!opened.ok) return `【deck_sync】${opened.reason}`;

      const applied = applySnapshot({ root: rootOf(), snapshot: opened.snapshot });
      if (!applied.ok) return `【deck_sync】${applied.reason}`;

      const a = applied.applied;
      return [
        '【deck_sync】已合并（不是覆盖——本机原有的东西都还在）：',
        `· 分身记忆 ${a.memory} 条`,
        `· 习惯 ${a.habits} 条`,
        `· 自动化 ${a.jobs} 条`,
        `· 策略 ${a.rules} 条`,
        `· 皮肤${a.pet ? ` 已切成 ${opened.snapshot.pet.skin}` : ' 没变'}`,
        '',
        `来源导出时间：${opened.snapshot.exportedAt || '未知'}`,
      ].join('\n');
    }),
  };
}

export default { createSyncTool };
