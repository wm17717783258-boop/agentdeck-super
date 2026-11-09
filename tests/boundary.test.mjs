/**
 * 闭源边界守卫的回归测试。
 *
 * 为什么这条要进 `npm test` 而不是只留在发布脚本里：
 * 拆包（开源核心 + 闭源商业层）之后，最容易悄悄坏掉的就是这条边界 ——
 * 有人 `import` 一句 `../pro/xxx`，开源版装上去就是 MODULE_NOT_FOUND；
 * 有人把 `loadPro('market/xxx.js')` 的名字改了，就静默降级成"未安装商业层"，
 * 线上永远不报错、永远查不出来。这两种错都不该等到发版那天才发现。
 *
 * 第二条用例是**反证**：造一个故意违规的假仓库，确认守卫真的会红。
 * 只测"通过"的守卫，很可能只是空转（真出事了也一路绿灯）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = join(PKG, 'tools', 'guard-boundary.mjs');

function runGuard(root) {
  const r = spawnSync(process.execPath, [GUARD, '--skip-pack', ...(root ? ['--root', root] : [])], {
    cwd: root || PKG, encoding: 'utf8', timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

test('闭源边界：核心代码不静态引用 pro/，loadPro 调用点全部对得上契约', () => {
  const { status, out } = runGuard(null);
  assert.equal(status, 0, `边界守卫应当通过，实际退出码 ${status}：\n${out}`);
  // 不是"没报错就算过"：把关键结论钉住，免得守卫被改成空转还一路绿灯。
  assert.match(out, /规矩 2 通过/, '没看到「无静态引用」的结论');
  // 开源形态（没有 pro/ 目录）只校验调用点、不校模块文件，所以这句会是「规矩 3（部分）」。
  assert.match(out, /规矩 3（部分通过）|规矩 3 通过/, '没看到「loadPro 契约对齐」的结论');
  assert.match(out, /规矩 4 通过/, '没看到「pro/ 未被 git 跟踪」的结论');
});

test('闭源边界：守卫会真的拦下静态 import（造一个违规假仓库自证不是空转）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexi-guard-probe-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"probe","type":"module"}\n');
    writeFileSync(
      join(dir, 'lib', 'evil.js'),
      "import { placeOrder } from '../pro/market/purchase.js';\nexport default placeOrder;\n",
    );

    const { status, out } = runGuard(dir);
    assert.equal(status, 1, `守卫应当失败，实际退出码 ${status}：\n${out}`);
    assert.match(out, /静态引用闭源层/, '守卫没报出「静态引用闭源层」');
    assert.match(out, /lib\/evil\.js/, '报错里没点出违规文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('闭源边界：loadPro 写了不存在的模块名也会被拦（防静默降级）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexi-guard-spec-'));
  try {
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"probe","type":"module"}\n');
    writeFileSync(
      join(dir, 'lib', 'typo.js'),
      "import { loadPro } from './pro-resolve.js';\n"
      + "export const init = () => loadPro('market/purchse.js');\n", // 故意少一个 a
    );

    const { status, out } = runGuard(dir);
    assert.equal(status, 1, `守卫应当失败，实际退出码 ${status}：\n${out}`);
    assert.match(out, /loadPro 目标不在契约清单/, '守卫没报出「契约清单」这一类问题');
    assert.match(out, /market\/purchse\.js/, '报错里没点出写错的 spec');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
