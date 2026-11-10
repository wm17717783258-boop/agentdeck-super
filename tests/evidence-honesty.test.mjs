/**
 * tests/evidence-honesty.test.mjs —— 「依据」这一列不许撒谎。
 *
 * 背景：`nexi host list` 的「依据」列会原样进公开文档（docs/接入的Agent清单.md），
 * 用户据此决定"装之前要不要先 doctor 一下"。这一列一旦虚标，比没有这一列更糟 ——
 * 它把"我没验过"伪装成"我验过了"。
 *
 * 所以这里不做"数值快照"（钉死"必须 6 家"，那是把现状当正确答案），
 * 而是钉住**可验证的因果**：
 *
 *   ① confidence 只能是三档之一 —— 拼错会原样显示给用户（'tested' / 'ok' 之类）；
 *   ② 标了 verified 的，本机必须查得到痕迹（nexi 备份 或 配置里的 nexi 条目）。
 *      查不到就是虚标 → 红。本机没装这家 → skip（不能证明它标错）。
 *   ③ `--md` 与 `--json` 对同一家必须说同一句话（表格和机器读的不能两套口径）。
 *
 * ② 是这套测试的核心：它把"我记得装过"换成了"磁盘上有证据"。
 * 在没装过任何宿主的 CI 机器上，② 会整片 skip —— 这是对的，
 * 它只在有证据可查的地方才有资格发言。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(ROOT, 'bin', 'nexi.mjs');

const CONFIDENCE = new Set(['verified', 'docs', 'community']);

function nexiJson(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, NEXI_LOG: '0' },
  });
  assert.equal(r.status, 0, `nexi ${args.join(' ')} 退出码非 0：${r.stderr?.slice(0, 400)}`);
  return JSON.parse(r.stdout);
}

/** 这家宿主在本机留下的痕迹：备份文件数 + 配置里有没有 nexi 条目。 */
function tracesOf(hostPath) {
  const dir = path.dirname(hostPath);
  const base = path.basename(hostPath);
  let backups = [];
  try {
    backups = readdirSync(dir).filter((n) => n.startsWith(`${base}.nexi-backup-`));
  } catch { /* 目录不存在 = 没装过 */ }
  let hasEntry = false;
  try {
    hasEntry = readFileSync(hostPath, 'utf8').includes('nexi');
  } catch { /* 同上 */ }
  return { backups, hasEntry, exists: existsSync(hostPath) };
}

// ── ① 取值域 ────────────────────────────────────────────────────────────────

test('依据列：confidence 只能是 verified / docs / community 三档', () => {
  const { hosts } = nexiJson(['host', 'list', '--json']);
  const bad = hosts.filter((h) => !CONFIDENCE.has(h.confidence));
  assert.deepEqual(
    bad.map((h) => `${h.id}=${h.confidence}`),
    [],
    '有人把依据写成了三档之外的值 —— 它会原样显示给用户，用户看不懂也不该看懂',
  );
});

test('依据列：每家在 --json 里都得有 confidence（缺省不能是空）', () => {
  const { hosts } = nexiJson(['host', 'list', '--json']);
  const missing = hosts.filter((h) => !h.confidence);
  assert.deepEqual(missing.map((h) => h.id), []);
});

// ── ② 标 verified 必须有磁盘证据 ─────────────────────────────────────────────

test('依据列：标了 verified 的，本机必须查得到 nexi 痕迹', (t) => {
  const { hosts } = nexiJson(['host', 'list', '--json']);
  const claimed = hosts.filter((h) => h.confidence === 'verified');

  // 一台没装过宿主的机器上，这个测试没有发言权 —— 明说 skip，不假装通过。
  if (claimed.length === 0) {
    t.skip('本机没有任何宿主标 verified');
    return;
  }

  const noEvidence = [];
  let checked = 0;
  for (const h of claimed) {
    const tr = tracesOf(h.path || '');
    // 配置文件本身都不在 → 本机没这家宿主，不能据此判断标错
    if (!tr.exists) continue;
    checked += 1;
    if (tr.backups.length === 0 && !tr.hasEntry) {
      // 走 CLI 写入的宿主要看配置文件里有没有条目；文件在但没条目 = 没装过
      noEvidence.push(h.id);
    }
  }

  if (checked === 0) {
    t.skip('本机标 verified 的宿主一个都没装，无法核对');
    return;
  }

  assert.deepEqual(
    noEvidence,
    [],
    `这些标了「本机实装」但磁盘上找不到任何 nexi 痕迹（无备份、配置里也没条目）：${noEvidence.join(', ')}`,
  );
});

test('依据列：社区约定必须给出可查的官方地址', () => {
  const { hosts } = nexiJson(['host', 'list', '--json']);
  const community = hosts.filter((h) => h.confidence === 'community');
  // 这一档最不可信（没有文档写清 MCP 配置长什么样，是推出来的）。
  // 越是不可信，越得给用户一个能自己去核的地方 —— 总不能让人只能信我们。
  const noDocs = community.filter((h) => !h.docs);
  assert.deepEqual(
    noDocs.map((h) => h.id),
    [],
    '这些标了社区约定又没有官方地址 —— 用户连自己核证的去处都没有',
  );
});

test('依据列：文档核对的也必须带官方地址', () => {
  const { hosts } = nexiJson(['host', 'list', '--json']);
  const noDocs = hosts.filter((h) => h.confidence === 'docs' && !h.docs);
  assert.deepEqual(
    noDocs.map((h) => h.id),
    [],
    '这些标了文档核对却没写核的是哪份文档 —— 无法复核等于没核',
  );
});

// ── ③ 表格与 JSON 不能两套口径 ──────────────────────────────────────────────

test('依据列：--md 表格与 --json 对同一家说同一句话', () => {
  const json = nexiJson(['host', 'list', '--json']);
  const r = spawnSync(process.execPath, [CLI, 'host', 'list', '--md'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: { ...process.env, NEXI_LOG: '0' },
  });
  assert.equal(r.status, 0);
  const md = r.stdout;

  const label = { verified: '本机实装', docs: '文档核对', community: '社区约定' };
  const mismatched = [];
  for (const h of json.hosts) {
    const row = md.split('\n').find((l) => l.includes(`\`${h.id}\``));
    assert.ok(row, `表格里找不到 ${h.id}`);
    const want = label[h.confidence];
    if (!row.includes(want)) mismatched.push(`${h.id} 期望「${want}」`);
  }
  assert.deepEqual(mismatched, [], 'Markdown 表格和 JSON 的依据列口径不一致');
});

test('依据列：清单文档与代码不脱节', () => {
  // docs/接入的Agent清单.md 是从 `host list --md` 生成的。宿主数量变了却没重新生成，
  // 文档就会悄悄比代码少几家 —— 这是最容易发生、也最没人发现的那种腐烂。
  const docPath = path.join(ROOT, 'docs', '接入的Agent清单.md');
  assert.ok(existsSync(docPath), '清单文档不见了');
  const doc = readFileSync(docPath, 'utf8');
  const { hosts } = nexiJson(['host', 'list', '--json']);

  const missing = hosts.filter((h) => !doc.includes(`\`${h.id}\``)).map((h) => h.id);
  assert.deepEqual(
    missing,
    [],
    `这些宿主在代码里有、文档里没有 —— 重新跑 nexi host list --md > docs/接入的Agent清单.md：${missing.join(', ')}`,
  );
});
