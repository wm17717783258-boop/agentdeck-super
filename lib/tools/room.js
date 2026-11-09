/**
 * tools/room.js —— `deck_room` 工具（跨机协作房间）
 *
 * 为什么需要这个工具：跨机协作对用户来说只该有两个动作——「建个房间」和「进这个房间」，
 * 剩下的推/拉同步不该让人手动敲 curl。所以这里把 lib/room.js 的八个方法收成六个动作，
 * 并且只在用户明确要同步时才动网络（sync/info），避免聊天时莫名其妙发请求。
 *
 * 三个设计取舍（都是踩过坑才这么定的）：
 *   1) 房间客户端按「relayUrl + 工作区 + teamId + 授权档位」缓存复用，绝不每次 new：
 *      room.js 的会话（seatId/syncToken/cursor）在客户端实例里，new 一次就把游标丢了，
 *      表现为"每次同步都从头拉一遍"。
 *   2) 新客户端起来先 resume 上次房间：把 roomId 记在 .agentdeck/rooms/last.json，
 *      重启会话后 sync 仍然接着上次的游标，不需要用户重新贴邀请链接。
 *   3) 免费版建云房间的失败（needUpgrade）不当错误报：说清"哪一档才有云房间 + 怎么办"，
 *      用户在免费版里的单机体验完全不受影响。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeDeps, safeExecute, emitSafe, clipText } from './common.js';

const ACTIONS = ['create', 'join', 'sync', 'info', 'close', 'leave'];

/** 房间会话目录：与 lib/room.js 保持同一处（.agentdeck/rooms）。 */
function roomsDir(root) {
  return join(root, '.agentdeck', 'rooms');
}

/** last.json：记住"这台机器最后一次进的房间"，用于重启后 resume。 */
function lastPointer(root) {
  return join(roomsDir(root), 'last.json');
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 找最近写入的房间会话文件里的 roomId（last.json 丢了也能兜住）。 */
function newestRoomId(root) {
  try {
    const dir = roomsDir(root);
    if (!existsSync(dir)) return null;
    const rows = readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'last.json')
      .map((f) => {
        const p = join(dir, f);
        let at = 0;
        try { at = statSync(p).mtimeMs; } catch { at = 0; }
        return { p, at };
      })
      .sort((a, b) => b.at - a.at);
    for (const row of rows) {
      const data = readJsonFile(row.p);
      if (data && data.roomId) return String(data.roomId);
    }
    return null;
  } catch {
    return null;
  }
}

/** 原子写 last.json（不会因为写一半断电变成坏 JSON）。 */
function writeLast(root, patch) {
  try {
    const dir = roomsDir(root);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const p = lastPointer(root);
    const old = readJsonFile(p) || {};
    const next = { ...old, ...patch, updatedAt: new Date().toISOString() };
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, p);
    return next;
  } catch {
    return null;
  }
}

/**
 * 从「完整邀请链接」或「roomId + 邀请码」里抽出两样东西。
 * 链接形如 dsh://agentdeck/join?room=room_xxx&t=xxxx（relay 建房间时就是这么发的）。
 */
function parseInvite(input) {
  const s = String(input || '').trim();
  const out = { roomId: '', inviteToken: '' };
  if (!s) return out;
  try {
    const u = new URL(s);
    out.roomId = String(u.searchParams.get('room') || u.searchParams.get('roomId') || '');
    out.inviteToken = String(u.searchParams.get('t') || u.searchParams.get('token') || u.searchParams.get('inviteToken') || '');
    if (out.roomId || out.inviteToken) return out;
  } catch {
    // dsh:// 这类非标准 scheme 在个别运行时解析不出来，退回正则
  }
  const m = s.match(/[?&]room=([^&\s]+)/i);
  if (m) out.roomId = decodeURIComponent(m[1]);
  const tk = s.match(/[?&](?:t|token|inviteToken)=([^&\s]+)/i);
  if (tk) out.inviteToken = decodeURIComponent(tk[1]);
  if (!out.roomId && !out.inviteToken && /^room_[A-Za-z0-9]+$/.test(s)) out.roomId = s;
  return out;
}

/** 把房间对象写成一行人话。 */
function fmtRoom(room) {
  if (!room) return '（还没有房间）';
  const host = room.host ? '房主' : '成员';
  return `${room.roomId}${room.name ? `（${room.name}）` : ''} · ${host} · 席位 ${room.seatId || '?'}`;
}

function fmtMembers(members) {
  if (!Array.isArray(members) || !members.length) return '成员：还没同步到成员列表（sync 或 info 一次就有）';
  const names = members.slice(0, 12).map((m) => `${m.name || m.seatId || '匿名'}${m.role && m.role !== 'worker' ? `(${m.role})` : ''}`);
  return `成员 ${members.length} 人：${names.join('、')}${members.length > 12 ? ' …' : ''}`;
}

export function createRoomTool(deps) {
  const d = normalizeDeps(deps);
  /** 缓存的房间客户端（同 relayUrl/工作区/小组/档位复用）。 */
  let client = null;
  let cacheKey = '';
  /** 当前房间 id：跟着会话走，重启后从 last.json 恢复。 */
  let roomId = '';

  const rootOf = () => (d.root ? String(d.root()) : String(d.workspace || process.cwd()));
  // 授权跟人走、跟项目无关：读授权一律用机级目录，别拿工作区当授权根
  // （踩过的坑：工作区里没有 key.txt → 明明激活了工作室版，建云房间还说"你是免费版"）
  const licRoot = () => (d.licenseRoot ? String(d.licenseRoot()) : rootOf());
  /**
   * 本次调用的临时 relay 覆盖（真机测试必需）。
   *
   * 为什么要有：以前 relayUrl 只能从配置/环境变量读，用户在命令行里指定自己那台机器的
   * 地址是做不到的 —— 真机测试时只能先去改配置文件，多设备场景非常别扭（真机踩到过）。
   * 现在 create/join 允许直接传 relayUrl 覆盖本次调用，优先级最高。
   * 只影响这一次调用，不落盘、不改全局配置。
   */
  let relayOverride = '';

  const relayUrl = () =>
    String(
      relayOverride ||
      d.cfg?.cloud?.relayUrl ||
      d.cfg?.relayUrl ||
      process.env.AGENTDECK_RELAY_URL ||
      '',
    ).trim().replace(/\/+$/, '');

  function licenseNow(root) {
    try {
      if (typeof d.license?.currentLicense === 'function') return d.license.currentLicense(root);
    } catch {
      /* 授权模块坏了也当免费版 */
    }
    return null;
  }

  function petSkin() {
    try {
      return String(d.pet?.get?.()?.skins?.active || 'basic');
    } catch {
      return 'basic';
    }
  }

  /**
   * 房间被房主关掉时统一这么说：这是正常终点，不是故障。
   * agent 循环看到这段话就该停手，而不是每个 tick 重试 sync 刷一屏红字。
   */
  function roomClosedText(rid) {
    return [
      `【deck_room】房间 ${rid || '（当前房间）'} 已经被房主关闭，同步到此为止（正常结束，不是故障，不用再 sync 了）。`,
      '本地任务板上的任务、事件都还在，team_board 照常能看；只是不再和那台机器合并。',
      '还想一起干：让房主重开一个房间把新邀请发你，或者自己 deck_room create 建一个。',
    ].join('\n');
  }

  /**
   * 判断一次失败是不是「房间已关闭」。
   * pull() 会明确给 closed:true，但 push()/旧 relay 只会把话写在 reason 里（HTTP 410 或 room_closed），
   * 所以这里两种都认；认不出来就当普通故障，别乱猜。
   */
  function looksClosed(res) {
    if (!res) return false;
    if (res.closed === true) return true;
    return /已关闭|room_closed|HTTP 410/.test(String(res.reason || ''));
  }

  /** 取（或重建）房间客户端；失败返回人话原因，绝不抛。 */
  function ensure(teamId) {
    const mod = d.room;
    if (!mod || typeof mod.createRoomClient !== 'function') {
      return { ok: false, reason: '房间模块没有加载（lib/room.js 缺失或加载失败），跨机功能不可用；本地任务板与工具不受影响。' };
    }
    const base = relayUrl();
    if (!base) {
      return {
        ok: false,
        reason: [
          '还没有配置 relay 地址，跨机房间连不出去。两种办法：',
          '① 自建（局域网/公网都行）：node tools/relay-server.mjs --port 8787 → 在插件设置里把 cloud.relayUrl 填成 http://127.0.0.1:8787',
          '② 用官方 relay：设置里填 https://relay.agentdeck.dev（协作版授权起可用）',
          '本地任务板、超级 Agent、桌宠都不需要 relay，照常可用。',
        ].join('\n'),
      };
    }
    const root = rootOf();
    const lic = licenseNow(licRoot());
    const tier = String(lic?.tier || 'free');
    const key = `${base}|${root}|${teamId || ''}|${tier}`;
    if (client && cacheKey === key) return { ok: true, client };
    client = mod.createRoomClient({
      relayUrl: base,
      root,
      board: d.board,
      teamId: teamId || '',
      license: lic,
      log: (msg) => {
        // 房间落盘失败之类只记一行，不打扰用户
        try {
          d.log?.(`房间：${clipText(String(msg), 200)}`);
        } catch { /* 忽略 */ }
      },
    });
    cacheKey = key;
    // resume 而不是 new：把上次的 seatId / syncToken / cursor 全部接回来
    const rid = roomId || newestRoomId(root) || readJsonFile(lastPointer(root))?.roomId || '';
    if (rid) {
      try {
        const r = client.resume(String(rid));
        if (r?.ok) roomId = String(rid);
      } catch {
        /* 会话文件坏了就当没进过房间 */
      }
    }
    return { ok: true, client };
  }

  function teamIdOf(args) {
    const explicit = String(args.teamId || '').trim();
    if (explicit) return explicit;
    if (d.cfg?.teamId) return String(d.cfg.teamId);
    try {
      const teams = d.board?.listTeams?.() || [];
      if (teams.length === 1) return String(teams[0].id);
      if (teams.length > 1) return '';
    } catch { /* 任务板坏了也不拦住房房间 */ }
    return '';
  }

  return {
    name: 'deck_room',
    description: [
      '跨机协作房间：create=建房间并拿到可微信发出去的邀请链接（装 DSH 的深链 + 没装 DSH 的网页加入页），join=用邀请链接/房间号进房间，',
      'sync=把本地任务推上去并拉回别人的任务（报告"推上去 N 条、拉回来 M 条"），info=看房间成员，close=房主关房，leave=退出房间。',
      '什么时候用：用户说"和同事一起干活/让另一台机器加入/把任务同步过去"。单人单机不需要这个工具。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: '动作：create / join / sync / info / close / leave。' },
        name: { type: 'string', description: '建房时的房间名（如"支付重构"）；不填用默认名字。' },
        inviteUrl: { type: 'string', description: 'join 时贴完整邀请链接（dsh://agentdeck/join?room=…&t=… 或 relay 给的网页加入页链接都行）。' },
        memberName: { type: 'string', description: 'join 时本机在房间里的席位名（建议“姓名-部门”或“姓名-设备”）；不填显示“客人”。房主用 info 能看到这个名字。' },
        roomId: { type: 'string', description: '房间号（join 时和 inviteToken 一起用；sync/info/close/leave 可省略，默认用当前房间）。' },
        inviteToken: { type: 'string', description: '邀请码（join 时和 roomId 一起用）。' },
        waitSec: { type: 'number', description: 'sync 时最多长轮询多少秒（0-30，默认 0 立即返回；等别人时给 10）。' },
        teamId: { type: 'string', description: '把这个小组的任务板接到房间；不填用默认小组。' },
        relayUrl: {
          type: 'string',
          description: '本次调用用的中继地址（可选）。真机多设备测试时直接在命令里指定"房主那台机器的地址"，不用先去改配置文件。例：http://192.168.1.10:8787 。只影响这一次调用。',
        },
      },
      required: ['action'],
    },
    // 宿主契约（§2.8）：每个工具都要自带 { schema, render }；房间的每个动作也只产出一段人话。
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string', description: '给人看的纯文本结果' } },
        required: ['text'],
      },
      render(args, value) {
        const text = typeof value === 'string' ? value : String(value?.text ?? '');
        return [{ type: 'text', text }];
      },
    },
    execute: safeExecute('deck_room', async (args) => {
      const action = String(args.action || '').toLowerCase();
      if (!ACTIONS.includes(action)) {
        return `【deck_room】不认识的动作 "${action || '(空)'}"。可用：${ACTIONS.join('、')}。`;
      }
      const root = rootOf();
      const teamId = teamIdOf(args);
      // 本次调用可以覆盖 relay 地址（真机测试用；不写配置也能指定自己那台机器）。
      //
      // 真机踩到的坑：guest 拿着房主给的邀请链接进房时，如果链接是「网页加入页」形态
      // （http://192.168.x.x:8787/?room=…&t=…），地址其实就在链接里，用户不该再手填一次。
      // 以前 ensure() 在解析邀请链接之前就跑，于是报"还没有配置 relay 地址"——
      // 明明链接里写着地址。所以这里在 ensure() 之前先把链接里的地址抠出来。
      let fromInvite = '';
      if (action === 'join' && args.inviteUrl) {
        try {
          const u = new URL(String(args.inviteUrl));
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            fromInvite = `${u.protocol}//${u.host}`;
          }
        } catch {
          // dsh:// 深链抠不出 http 地址，属正常（那就得靠 relayUrl 参数或配置）
        }
      }
      relayOverride = String(args.relayUrl || fromInvite || '').trim().replace(/\/+$/, '');
      // 还是空的话，看上次进房记下的地址（sync/info/close 这些"后续调用"靠它）
      if (!relayOverride) {
        try {
          const roomDir = roomsDir(root);
          const pointer = lastPointer(root);
          if (existsSync(pointer)) {
            const last = JSON.parse(readFileSync(pointer, 'utf8'));
            relayOverride = String(last?.relayUrl || '').trim().replace(/\/+$/, '');
          }
        } catch {
          // 读不到就当没有，走原来的报错分支（不因为读 last.json 失败而崩）
        }
      }
      const got = ensure(teamId);
      // 先把这次用的地址留住，再清 override ——
      // 否则后面 writeLast 调 relayUrl() 拿到的已经是空的了（真机踩过）
      const usedRelay = relayUrl();
      relayOverride = '';   // 用完就清：别让下一次调用莫名其妙还带着这次的值
      if (!got.ok) return `【deck_room】${got.reason}`;
      const c = got.client;

      if (action === 'create') {
        const name = String(args.name || '').trim();
        const res = await c.createRoom({ name, petSkin: petSkin() });
        if (!res.ok) {
          if (res.needUpgrade) {
            return [
              '【deck_room】这台机器现在是免费版，建不了跨机云房间。',
              `原因：${res.reason}`,
              '',
              '怎么办：',
              '① deck_license plans 看价格 → 付款拿到授权码',
              '② deck_license activate 粘贴授权码（或打开 /deck 状态页粘贴）',
              '③ 再来一次 deck_room create',
              '',
              '只想让同一个小组在本机内跑：继续用 team_orchestrate / team_board，不需要房间。',
            ].join('\n');
          }
          return `【deck_room】建房间失败：${res.reason}`;
        }
        const room = res.room || {};
        roomId = String(room.roomId || '');
        const link = String(res.inviteUrl || room.inviteUrl || '');
        // relay 新版会多给一条网页邀请链接：给「同事没装 DSH」的情况用，打开就是加入页。
        // 老 relay 没有这个字段，那就只发深链，不硬编一条打不开的地址。
        const webLink = String(res.inviteWebUrl || room.inviteWebUrl || '');
        const token = String(res.inviteToken || room.inviteToken || '');
        // 必须把这次用的 relay 地址一起记下来 —— 否则房主建完房间，
        // 下一次 sync/info 就报"还没有配置 relay 地址"，房间等于白建
        // （真机自检第 9 轮抓到的：用 relayUrl 参数建房，随后 sync 就丢了地址）
        writeLast(root, {
          roomId,
          name: room.name || name,
          inviteUrl: link,
          inviteWebUrl: webLink,
          inviteToken: token,
          host: true,
          relayUrl: usedRelay || '',
        });
        emitSafe(d, 'room_create', { roomId, teamId });
        return [
          `【deck_room】房间已建好：${fmtRoom(room)}`,
          token ? `邀请码：${token}（房主关房后失效）` : '',
          link ? `装了 DSH 的人点这个直接进：\n${link}` : '（relay 没返回邀请链接，用 deck_room info 再看一次）',
          webLink
            ? `没装 DSH 的人点这个（网页加入页，页面里有安装命令）：\n${webLink}`
            : '',
          '',
          '对方怎么进：装好同一个插件 → 打开对话 → 让 Agent 调 deck_room join，把上面整条链接贴进去。',
          '两边都进了房间后，各自 deck_room sync 一次，任务板就合并了（谁认领的任务会同步到对方）。',
          res.seats ? `这个房间还能进 ${Math.max(0, Number(res.seats) - 1)} 个席位。` : '',
        ].filter(Boolean).join('\n');
      }

      if (action === 'join') {
        const invite = parseInvite(args.inviteUrl);
        const rid = String(args.roomId || invite.roomId || '').trim();
        const tok = String(args.inviteToken || invite.inviteToken || '').trim();
        if (!rid || !tok) {
          return [
            '【deck_room】进房间需要房间号和邀请码。最省事的做法：把同事发你的整条邀请链接贴进来。',
            `	dsh://agentdeck/join?room=room_xxx&t=邀请码`,
            '如果链接打不开，就分别给 roomId 和 inviteToken 两个参数。',
          ].join('\n');
        }
        const memberName = String(args.memberName || '').trim().slice(0, 40);
        const res = await c.joinRoom({
          roomId: rid,
          inviteToken: tok,
          inviteUrl: String(args.inviteUrl || '') || undefined,
          ...(memberName ? { member: { name: memberName } } : {}),
          petSkin: petSkin(),
        });
        if (!res.ok) {
          const hint = res.code === 'bad_invite' || /失效|不对|无效/.test(String(res.reason))
            ? '（邀请码可能已被重新生成：让房主 deck_room info 看一下最新邀请链接）'
            : '';
          return `【deck_room】进房间失败：${res.reason}${hint}`;
        }
        roomId = rid;
        const members = res.members || [];
        // 把这次用的 relay 地址一起记下来：进房之后的 sync/info/close 走的都是
        // **下一次 tool 调用**，那时 relayOverride 已经清了。不记住就会出现
        // "刚进房成功、一 sync 又说没配 relay"（真机踩到过）。
        writeLast(root, {
          roomId: rid,
          name: res.room?.name || '',
          host: false,
          members,
          // 用 usedRelay（在清 override 之前抓下来的值），
          // 不能再调 relayUrl() —— 那时 override 已经清了，拿到的是空串
          relayUrl: usedRelay || '',
        });
        emitSafe(d, 'room_join', { roomId: rid, teamId });
        return [
          `【deck_room】已进房间：${fmtRoom(res.room)}`,
          fmtMembers(members),
          '下一步：deck_room sync 把本地任务推上去、把房间里的任务拉下来。',
        ].join('\n');
      }

      if (action === 'sync') {
        const session = typeof c.session === 'function' ? c.session() : null;
        if (!session || !session.roomId) {
          return [
            '【deck_room】现在还没有进任何房间，没东西可同步。',
            '房主：deck_room create；成员：deck_room join 贴邀请链接。',
            '（本地任务板不受影响，team_board 照常能用。）',
          ].join('\n');
        }
        roomId = String(session.roomId);
        const waitSec = Math.min(30, Math.max(0, Number(args.waitSec) || 0));
        // 进房间之后第一件事：把房主的小组在本机复刻出来。
        // 少了这一步，远端任务没有落点（"team not found"），用户看到的就是「同步成功但板子还是空的」。
        const ensured = typeof c.ensureRoomTeam === 'function' ? c.ensureRoomTeam() : { ok: true, created: false, teamId: '' };
        if (ensured && ensured.ok === false) {
          d.log?.(`房间：小组复刻失败 ${clipText(String(ensured.reason || ''), 200)}`);
        }
        // 先推本地新任务：board → relay
        let pushed = { ok: true, accepted: 0 };
        try {
          pushed = await c.publishLocalTasks();
        } catch (err) {
          pushed = { ok: false, reason: err?.message || String(err) };
        }
        if (!pushed.ok) {
          // 推不上去最常见的原因就是房主关了房：这不是要用户修的错误，直接按「结束」讲。
          if (looksClosed(pushed)) {
            writeLast(root, { roomId, closed: true, closedAt: new Date().toISOString() });
            return roomClosedText(roomId);
          }
          return `【deck_room】推送本地任务失败：${pushed.reason || '未知原因'}（拉回远端那一步没做，避免状态半新半旧）。`;
        }
        // 再拉远端：relay → board（waitSec>0 时是长轮询，适合等同事交活）
        const pulled = await c.pull({ waitSec });
        if (pulled.closed) {
          writeLast(root, { roomId, closed: true, closedAt: new Date().toISOString() });
          emitSafe(d, 'room_closed', { roomId });
          return roomClosedText(roomId);
        }
        if (!pulled.ok) {
          return `【deck_room】本地任务已推上去 ${pushed.accepted ?? 0} 条，但拉取失败：${pulled.reason || '未知原因'}。稍后再 sync 一次即可（游标没前进，不会丢事件）。`;
        }
        const members = pulled.members || [];
        writeLast(root, { roomId, members, lastSyncAt: new Date().toISOString() });
        emitSafe(d, 'room_sync', { roomId, pushed: pushed.accepted || 0, pulled: pulled.fetched || 0 });
        const fetched = pulled.fetched || 0;
        const applied = pulled.applied || 0;
        const appliedTasks = Number.isFinite(pulled.appliedTasks) ? pulled.appliedTasks : applied;
        const skipped = Math.max(0, fetched - applied);
        const lines = [
          `【deck_room】已同步房间 ${roomId}：推上去 ${pushed.accepted || 0} 条、拉回来 ${fetched} 条（其中落到本机任务板 ${appliedTasks} 条${skipped ? `，另 ${skipped} 条是自己发的或之前已经拉过` : ''}）。`,
        ];
        if (ensured && ensured.created) lines.push(`已在本机复刻房主的小组 ${ensured.teamId}：从现在起两边的任务在同一个小组里，team_board list 用这个 id 看。`);
        if ((pushed.accepted || 0) === 0 && (pulled.fetched || 0) === 0) lines.push('提示：两边任务板没有新变化。要不要 team_board list 看看还有哪些待办？');
        if (fetched > 0 && appliedTasks === 0 && !ensured?.created) lines.push(`提醒：这次拉回来的 ${fetched} 条没有新内容落到板子上（自己发的事件或重复事件都算）。以 team_board list 的结果为准。`);
        lines.push(fmtMembers(members));
        if (pulled.closed) lines.push('注意：房间已被房主关闭，后续同步会失败；本地任务仍然都在。');
        return lines.join('\n');
      }

      if (action === 'info') {
        const rid = String(args.roomId || roomId || '').trim();
        if (rid && rid !== roomId) {
          // 指定了别的房间：先切过去
          try {
            const r = c.resume(rid);
            if (r?.ok) roomId = rid;
            else return `【deck_room】本地没有房间 ${rid} 的会话记录（没进过这个房间，或记录被清掉了）。让房主重发邀请链接，用 join 进一次。`;
          } catch {
            return `【deck_room】本地没有房间 ${rid} 的会话记录，先进一次再查。`;
          }
        }
        const res = await c.info();
        if (!res.ok) return `【deck_room】查询失败：${res.reason}`;
        const members = res.members || res.seats || [];
        writeLast(root, { roomId: roomId || res.roomId, members });
        const session = typeof c.session === 'function' ? c.session() : {};
        // 会话里带着 inviteWebUrl 就一起给：房主转发时不用再翻建房间那条消息。
        if (session.inviteUrl || session.inviteWebUrl) {
          writeLast(root, {
            roomId: roomId || session.roomId,
            inviteUrl: String(session.inviteUrl || ''),
            inviteWebUrl: String(session.inviteWebUrl || ''),
          });
        }
        return [
          `【deck_room】房间信息：${fmtRoom(session)}`,
          fmtMembers(members),
          typeof res.closedAt === 'string' ? `关闭时间：${res.closedAt}` : '房间状态：开放中',
          session.inviteUrl ? `装了 DSH 的邀请链接：${session.inviteUrl}` : '',
          session.inviteWebUrl ? `没装 DSH 的网页加入页：${session.inviteWebUrl}` : '',
        ].filter(Boolean).join('\n');
      }

      if (action === 'close') {
        const res = await c.closeRoom();
        if (!res.ok) return `【deck_room】关房失败：${res.reason}`;
        writeLast(root, { roomId, closed: true, closedAt: res.closedAt || new Date().toISOString() });
        emitSafe(d, 'room_close', { roomId });
        return `【deck_room】房间 ${roomId} 已关闭。成员的本地任务都还在，只是不能再同步了。`;
      }

      // leave
      const res = await c.leave();
      if (!res.ok) return `【deck_room】退出失败：${res.reason}`;
      writeLast(root, { roomId, leftAt: new Date().toISOString() });
      emitSafe(d, 'room_leave', { roomId });
      return `【deck_room】已退出房间 ${roomId}。本地任务板不受影响；想再进去用 deck_room join 贴邀请链接。`;
    }),
  };
}

export default { createRoomTool };
