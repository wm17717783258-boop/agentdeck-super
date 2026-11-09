/**
 * tests/pair-seats.test.mjs —— 真机配对的测试席位参数。
 *
 * 目的不是制造生产授权，而是让同一份包能按 2/5/10/20/50 台设备逐级扩容测试。
 * 默认仍保持 plus/8，避免旧流程变化；显式传 --tier/--seats 才扩大。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairSeatConfig } from '../tools/nexi-pair.mjs';

test('pairSeatConfig：默认仍是协作版 8 席', () => {
  assert.deepEqual(pairSeatConfig(), {
    ok: true,
    tier: 'plus',
    label: '协作版',
    seats: 8,
    maxSeats: 8,
  });
});

test('pairSeatConfig：企业版可按显式席位测试', () => {
  const r = pairSeatConfig('business', '50');
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'business');
  assert.equal(r.seats, 50);
  assert.equal(r.maxSeats, 200);
});

test('pairSeatConfig：不允许超过档位上限或传垃圾值', () => {
  assert.equal(pairSeatConfig('plus', '9').ok, false);
  assert.equal(pairSeatConfig('business', '201').ok, false);
  assert.equal(pairSeatConfig('studio', '0').ok, false);
  assert.equal(pairSeatConfig('studio', '1.5').ok, false);
  assert.equal(pairSeatConfig('enterprise', '10').ok, false);
});
