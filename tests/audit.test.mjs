/**
 * tests/audit.test.mjs —— 审计流（lib/policy/audit.js）与 deck_audit 工具的实测
 *
 * 铁律：每个"读到了/导出了"都得能在盘上找到痕迹 —— 断言落在真实的
 * audit.jsonl / state.json 上，独立 tmpdir，不碰本机状态。
 * 也测降级：没有任务板、任务板抛错、审计文件坏行，都必须给提示而不是崩。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { appendAudit, normalizeAuditRecord, readAudit } from '../lib/policy/audit.js';
import { createAuditTool } from '../lib/tools/audit.js';
import { createBoard } from '../lib/engine/board.js';

function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `nexi-audit-${label}-`));
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** safeExecute 统一返回 { text }；测试只关心文本，包一层省得处处 .text。 */
function plain(tool) {
  return {
    ...tool,
    execute: async (args) => {
      const out = await tool.execute(args);
      return typeof out === 'string' ? out : String(out?.text ?? '');
    },
  };
}

function seed(root, list) {
  for (const item of list) {
    const res = appendAudit(root, item);
    assert.equal(res.ok, true, `审计写盘失败：${res.error}`);
  }
}

const THREE = [
  { ts: '2026-05-01T10:00:00.000Z', tool: 'deck_room', action: 'send', result: 'failed', kind: 'host', text: '发消息失败' },
  { ts: '2026-05-01T11:00:00.000Z', tool: 'team_board', action: 'add', result: 'ok', kind: 'board', text: '加任务', teamId: 'team_a' },
  { ts: '2026-05-01T12:00:00.000Z', tool: 'deck_market', action: 'buy', result: 'deny', kind: 'policy/check', text: '被策略拒绝' },
];

test('normalizeAuditRecord：任务板事件 {payload:{tool,action,ok:false}} 能还原成审计记录', () => {
  const record = normalizeAuditRecord({
    seq: 7,
    ts: '2026-05-01T10:00:00.000Z',
    kind: 'host',
    text: 'tool_call',
    payload: { tool: 'deck_room', action: 'send', ok: false },
  }, 'board');
  assert.equal(record.tool, 'deck_room');
  assert.equal(record.action, 'send');
  assert.equal(record.result, 'failed');
  assert.equal(record.kind, 'host');
  assert.equal(record.text, 'tool_call');
  assert.equal(record.source, 'board');
  assert.equal(record.seq, 7);
  assert.equal(record.ts, '2026-05-01T10:00:00.000Z');
});

test('normalizeAuditRecord：没有结果字段时按 kind 关键词推断，读不出来记 unknown', () => {
  assert.equal(normalizeAuditRecord({ kind: 'task/failed', ts: 1770000000000 }).result, 'failed');
  assert.equal(normalizeAuditRecord({ kind: 'task/done' }).result, 'ok');
  assert.equal(normalizeAuditRecord({ kind: 'note' }).result, 'unknown');
  // 时间解析不了就留空，不编一个假时间
  assert.equal(normalizeAuditRecord({ ts: '昨天' }).ts, '');
});

test('appendAudit → readAudit：三条记录按顺序回读；坏行跳过并计数，不抛错', () => {
  const { root, done } = freshRoot('roundtrip');
  try {
    seed(root, THREE);
    const file = join(root, 'audit.jsonl');
    assert.equal(existsSync(file), true);
    appendFileSync(file, 'not-json\n', 'utf8');

    const read = readAudit(root);
    assert.equal(read.ok, true);
    assert.equal(read.missing, false);
    assert.equal(read.records.length, 3);
    assert.equal(read.skipped, 1);
    assert.equal(read.totalLines, 4);
    assert.equal(read.records[0].tool, 'deck_room');
    assert.equal(read.records[2].result, 'deny');
  } finally {
    done();
  }
});

test('readAudit：文件不存在返回 missing，不抛错', () => {
  const { root, done } = freshRoot('missing');
  try {
    const read = readAudit(root);
    assert.equal(read.ok, true);
    assert.equal(read.missing, true);
    assert.deepEqual(read.records, []);
    assert.equal(read.skipped, 0);
  } finally {
    done();
  }
});

test('工具形状：name/parameters/output.render/execute 都是宿主认的', () => {
  const { root, done } = freshRoot('shape');
  try {
    const tool = createAuditTool({ root: () => root });
    assert.equal(tool.name, 'deck_audit');
    assert.equal(typeof tool.description, 'string');
    assert.deepEqual(tool.parameters.properties.action.enum, ['tail', 'query', 'export']);
    assert.equal(typeof tool.execute, 'function');
    assert.deepEqual(tool.output.render({}, { text: 'hi' }), [{ type: 'text', text: 'hi' }]);
    assert.deepEqual(tool.output.render({}, 'raw'), [{ type: 'text', text: 'raw' }]);
  } finally {
    done();
  }
});

test('tail：limit 只显示最近 N 条，头行给出筛选后/总数', async () => {
  const { root, done } = freshRoot('tail');
  try {
    seed(root, THREE);
    const tool = plain(createAuditTool({ root: () => root }));
    const text = await tool.execute({ action: 'tail', limit: 2 });
    assert.match(text, /最近 2 条（筛选后 3 条 \/ 共 3 条）/);
    assert.ok(text.includes('deck_market/buy'));
    assert.ok(text.includes('team_board/add'));
    assert.ok(!text.includes('deck_room/send'));
  } finally {
    done();
  }
});

test('query：按 result / tool 通配 / kind 过滤都真的生效', async () => {
  const { root, done } = freshRoot('query');
  try {
    seed(root, THREE);
    const tool = plain(createAuditTool({ root: () => root }));

    const failed = await tool.execute({ action: 'query', result: 'failed' });
    assert.match(failed, /匹配 1 条/);
    assert.ok(failed.includes('deck_room/send'));
    assert.ok(!failed.includes('deck_market/buy'));

    const deck = await tool.execute({ action: 'query', tool: 'deck_*' });
    assert.match(deck, /匹配 2 条/);
    assert.ok(deck.includes('deck_room/send'));
    assert.ok(deck.includes('deck_market/buy'));
    assert.ok(!deck.includes('team_board/add'));

    const kind = await tool.execute({ action: 'query', kind: 'policy' });
    assert.match(kind, /匹配 1 条/);
    assert.ok(kind.includes('deck_market/buy'));
  } finally {
    done();
  }
});

test('query：since/until 按时间过滤；看不懂的时间给提示而不是当成 0', async () => {
  const { root, done } = freshRoot('time');
  try {
    seed(root, [
      { ts: '2026-05-01T10:00:00.000Z', tool: 'deck_a', action: 'x', result: 'ok' },
      { ts: '2026-05-02T10:00:00.000Z', tool: 'deck_b', action: 'y', result: 'ok' },
    ]);
    const tool = plain(createAuditTool({ root: () => root }));

    const since = await tool.execute({ action: 'query', since: '2026-05-02T00:00:00.000Z' });
    assert.match(since, /匹配 1 条/);
    assert.ok(since.includes('deck_b/y'));

    const until = await tool.execute({ action: 'query', until: '2026-05-01T23:59:59.000Z' });
    assert.match(until, /匹配 1 条/);
    assert.ok(until.includes('deck_a/x'));

    const bad = await tool.execute({ action: 'query', since: '昨天' });
    assert.match(bad, /匹配 2 条/);
    assert.match(bad, /提示：.*since 看不懂/);
  } finally {
    done();
  }
});

test('真实任务板事件流：createBoard + appendEvent 的 tool_call 能被 tail/query 读到', async () => {
  const { root, done } = freshRoot('board');
  try {
    const board = createBoard({ root });
    const team = board.createTeam({ name: '审计组' });
    board.appendEvent(team.id, {
      kind: 'host',
      text: 'tool_call',
      payload: { tool: 'deck_room', action: 'send', ok: false },
    });

    const tool = plain(createAuditTool({ root: () => root, board }));
    const tail = await tool.execute({ action: 'tail' });
    assert.match(tail, /来源：.*任务板事件流/);
    assert.ok(tail.includes('deck_room/send'));
    assert.ok(tail.includes('failed'));

    const query = await tool.execute({ action: 'query', result: 'failed' });
    assert.match(query, /匹配 1 条/);
    assert.ok(query.includes('deck_room/send'));
  } finally {
    done();
  }
});

test('export：筛选结果写成真实 jsonl 文件，条数与每行 JSON 都能对上', async () => {
  const { root, done } = freshRoot('export');
  try {
    seed(root, THREE);
    const tool = plain(createAuditTool({ root: () => root }));
    const text = await tool.execute({ action: 'export', result: 'failed' });
    assert.match(text, /已导出 1 条：/);

    const matched = text.match(/已导出 \d+ 条：(.+\.jsonl)/);
    assert.ok(matched, `导出路径没解析出来：${text}`);
    const file = matched[1].trim();
    assert.equal(existsSync(file), true);
    assert.match(basename(file), /^audit-export-.+\.jsonl$/);

    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.tool, 'deck_room');
    assert.equal(parsed.result, 'failed');
  } finally {
    done();
  }
});

test('export：一条都没匹配到时也写出空文件，并明说 0 条', async () => {
  const { root, done } = freshRoot('export-empty');
  try {
    const tool = plain(createAuditTool({ root: () => root }));
    const text = await tool.execute({ action: 'export' });
    assert.match(text, /已导出 0 条/);
    const matched = text.match(/已导出 \d+ 条（[^）]*）：(.+\.jsonl)/);
    assert.ok(matched, `导出路径没解析出来：${text}`);
    const file = matched[1].trim();
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file, 'utf8'), '');
  } finally {
    done();
  }
});

test('降级：没有任务板、没有审计文件时，tail 只给提示，不抛错', async () => {
  const { root, done } = freshRoot('degrade');
  try {
    const tool = plain(createAuditTool({ root: () => root }));
    const text = await tool.execute({ action: 'tail' });
    assert.match(text, /来源：没有可读的审计来源/);
    assert.match(text, /本地审计流还没有内容/);
    assert.match(text, /任务板/);
    assert.match(text, /没有记录/);
  } finally {
    done();
  }
});

test('降级：任务板 listTeams 抛错时只降级提示，工具不崩', async () => {
  const { root, done } = freshRoot('board-throw');
  try {
    const board = {
      listTeams() { throw new Error('炸了'); },
      listEvents() { throw new Error('炸了'); },
    };
    const tool = plain(createAuditTool({ root: () => root, board }));
    const text = await tool.execute({ action: 'tail' });
    assert.match(text, /任务板/);
    assert.match(text, /来源：没有可读的审计来源/);
  } finally {
    done();
  }
});

test('展示前脱敏：审计记录里的手机号不会原样打出来', async () => {
  const { root, done } = freshRoot('redact');
  try {
    const phone = ['138', '1234', '5678'].join('');
    seed(root, [{ ts: '2026-05-01T10:00:00.000Z', tool: 'deck_room', action: 'send', result: 'ok', text: `电话 ${phone} 打给我` }]);
    const tool = plain(createAuditTool({ root: () => root }));
    const text = await tool.execute({ action: 'tail' });
    assert.ok(text.includes('138****5678'));
    assert.ok(!text.includes(phone));
  } finally {
    done();
  }
});
