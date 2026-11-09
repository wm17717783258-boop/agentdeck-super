#!/usr/bin/env node
/**
 * tests/fixtures/market-lock-child.mjs —— 跨进程写账本的子进程
 *
 * 用法：node market-lock-child.mjs <root> <tag> <count>
 * 做的事：往同一个 orders.json 里追加 <count> 条**互不相同**的订单，全程走 store.updateOrders
 * （也就是 purchase.js 真正用的那个原语），最后打印追加了多少条。
 *
 * 存在的理由：读-改-写竞态只有**真开多个进程**才能复现。
 * 同一个进程里 Promise.all 是没用的 —— Node 单线程，同步读写不会被交错，
 * 于是测试会假绿，而用户开了两个宿主（Claude Code + Cursor）就真丢单。
 */
import { createMarketStore } from '../../lib/market/store.js';

const root = process.argv[2];
const tag = process.argv[3] || 'p';
const count = Number(process.argv[4] || 5);

const store = createMarketStore({ root });
let written = 0;

for (let i = 0; i < count; i += 1) {
  const id = `ord_${tag}${String(i).padStart(6, '0')}`;
  const res = store.updateOrders((doc) => {
    if (!doc.orders.some((o) => o.id === id)) {
      doc.orders.push({
        id,
        skinId: 'premium-aurora',
        amount: 1800,
        currency: 'CNY',
        state: 'created',
        buyer: tag,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return doc;
  });
  if (res && res.ok) written += 1;
}

process.stdout.write(JSON.stringify({ written }));
