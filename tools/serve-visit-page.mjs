#!/usr/bin/env node
/**
 * 串门落地页演示主机：起一个**真 HTTP 服务**（带 /visit 与 /deck 路由），
 * 供截图脚本用。故意拆成常驻进程，方便用 Edge / 浏览器各截各的。
 *
 * 用法：node tools/serve-visit-page.mjs [port]
 * 退出：Ctrl+C 或 kill。写完 URL 会打印一行 `READY <json>`。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createHub } from '../lib/hub.js';

const port = Number(process.argv[2] || 57961);
const ROOT = 'D:\\demo\\visitpage';

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(ROOT, 'work', '.agentdeck', 'pet'), { recursive: true });

const routes = [];
const server = createServer((req, res) => {
  const pathname = String(req.url || '/').split('?')[0];
  const hit = routes.find((r) => (r.kind === 'exact' ? pathname === r.path : pathname.startsWith(r.path)));
  if (!hit) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404（这个演示主机只挂了 /visit、/deck、/adbp）');
    return;
  }
  Promise.resolve(hit.handler(req, res)).catch((err) => {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err && err.message}`);
  });
});
await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

const hub = await createHub({
  workspace: join(ROOT, 'work'),
  boardRoot: join(ROOT, 'board'),
  petRoot: join(ROOT, 'work'),
  licenseRoot: join(ROOT, 'lic'),
  webServer: { port, register(route) { routes.push(route); return () => {}; } },
  onLog: () => {},
});

const { createProfileStore } = await import('../lib/pet/profile.js');
const store = createProfileStore({ root: join(ROOT, 'work') });
store.update((draft) => {
  draft.name = '小犀';
  draft.habits = [
    { key: 'sql-report', label: '每周写 SQL 周报', confidence: 0.82 },
    { key: 'code-review', label: '改完代码先让人 review', confidence: 0.66 },
  ];
});

const inviteText = (await hub.call('pet_visit', { action: 'invite', scope: 'work', ttlHours: 6 }))
  .map((b) => b.text || '')
  .join('\n');
const token = (inviteText.match(/[?&]t=([A-Za-z0-9._~-]+)/) || [])[1] || '';
if (!token) {
  console.error('没拿到邀请令牌');
  process.exit(1);
}
writeFileSync(join(ROOT, 'token.txt'), `${token}\n`, 'utf8');

const base = `http://127.0.0.1:${port}`;
console.log(`READY ${JSON.stringify({
  base,
  good: `${base}/visit?t=${token}`,
  noToken: `${base}/visit`,
  badToken: `${base}/visit?t=obviously-not-a-real-token`,
  deck: `${base}/deck`,
})}`);

const shutdown = async () => {
  try { await hub.close(); } catch { /* 关不掉就算了 */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
