/**
 * lib/team/index.js —— 团队空间对外门面
 *
 * Lead 接线只需要这一层：
 *   import { createTeamSpace } from './team/index.js';
 *   const team = createTeamSpace({ root: () => workspaceRoot, license });
 *   team.status(); team.join({ id:'王冕', name:'王冕' }); team.share({ text:'结论…' });
 *
 * 组合关系：
 *   space.js  成员 / 角色 / 席位 / 共享记忆（状态只有 <root>/team/space.json）
 *   audit.js  只增不改的审计（<root>/team/audit.jsonl）+ 导出 + 保留期清理
 *
 * 诚实边界：SSO / SCIM / 私有化部署**没有实现**，`UNIMPLEMENTED` 是唯一真相源，
 * 工具 `deck_team` 的 status 动作会原样把这份清单吐给用户，不许写"已支持"。
 */

import * as space from './space.js';
import * as audit from './audit.js';

export { space, audit };
export * from './space.js';
export * from './audit.js';

/**
 * 造一个绑定了 root/license 的门面，省得每个调用点都传一遍。
 * @param {{ root?: string|(()=>string), license?: any, licenseRoot?: string, now?: any }} [opts]
 * @returns 一套已经注入 root/license 的团队空间方法
 */
export function createTeamSpace(opts = {}) {
  const rootOf = () => {
    try {
      const r = typeof opts.root === 'function' ? opts.root() : opts.root;
      return String(r || process.cwd());
    } catch {
      return String(process.cwd());
    }
  };
  const license = opts.license ?? null;
  const now = opts.now;

  return {
    root: rootOf,
    // 建 / 查
    create: (o = {}) => space.createSpace({ root: rootOf(), license, now, ...o }),
    read: () => space.readSpace({ root: rootOf() }),
    status: (o = {}) => space.spaceStatus({ root: rootOf(), license, ...o }),
    // 成员
    join: (o = {}) => space.joinSpace({ root: rootOf(), license, now, ...o }),
    leave: (o = {}) => space.leaveSpace({ root: rootOf(), ...o }),
    remove: (o = {}) => space.removeMember({ root: rootOf(), ...o }),
    members: (o = {}) => space.listMembers({ root: rootOf(), ...o }),
    setRole: (o = {}) => space.setRole({ root: rootOf(), ...o }),
    // 共享记忆
    share: (o = {}) => space.shareMemory({ root: rootOf(), now, ...o }),
    recall: (o = {}) => space.recallTeamMemory({ root: rootOf(), now, ...o }),
    prune: (o = {}) => space.pruneExpiredMemory({ root: rootOf(), now, ...o }),
    // 审计
    audit: (o = {}) => audit.appendTeamAudit({ root: rootOf(), now, ...o }),
    auditList: (o = {}) => audit.readAudit({ root: rootOf(), ...o }),
    auditExport: (o = {}) => audit.exportAudit({ root: rootOf(), now, ...o }),
    auditSweep: (o = {}) => audit.retentionSweep({ root: rootOf(), now, ...o }),
    auditStats: (o = {}) => audit.auditStats({ root: rootOf(), ...o }),
  };
}

export default createTeamSpace;
