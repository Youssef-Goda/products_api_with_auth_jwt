'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calculateProductProfitability } = require('./productProfitability');
const { parsePurchaseCost } = require('./productCost');
const { hideInternalOrderCosts } = require('./internalFinance');

test('calculates gross profit and margin from backend price inputs', () => {
  assert.deepEqual(calculateProductProfitability({ costPrice: 60, sellingPrice: 100 }), {
    costPrice: 60, sellingPrice: 100, effectivePrice: 100, grossProfit: 40, grossMargin: 40, isBelowCost: false,
  });
});

test('unknown cost remains unknown and zero selling price has no margin', () => {
  assert.equal(calculateProductProfitability({ costPrice: null, sellingPrice: 0 }).grossProfit, null);
  assert.equal(calculateProductProfitability({ costPrice: 0, sellingPrice: 0 }).grossMargin, null);
});

test('discounted effective price reports loss and margin after discount', () => {
  const result = calculateProductProfitability({ costPrice: 80, sellingPrice: 100, effectivePrice: 70 });
  assert.equal(result.grossProfit, -10);
  assert.ok(Math.abs(result.grossMargin - (-100 / 7)) < 1e-12);
  assert.equal(result.isBelowCost, true);
});

test('rejects invalid effective monetary values', () => {
  assert.throws(() => calculateProductProfitability({ costPrice: 2, sellingPrice: 10, effectivePrice: NaN }));
});

test('validates optional purchase cost without treating missing as zero', () => {
  assert.equal(parsePurchaseCost(null), null);
  assert.equal(parsePurchaseCost('0'), 0);
  assert.equal(parsePurchaseCost('12.50'), 12.5);
  for (const value of ['-1', 'NaN', '1e3', '12.345', 'Infinity']) assert.throws(() => parsePurchaseCost(value));
});

test('strips snapshot costs from nested customer order payloads', () => {
  const result = hideInternalOrderCosts({ order_items: [{ unit_cost_snapshot: 25, quantity: 2 }] });
  assert.deepEqual(result, { order_items: [{ quantity: 2 }] });
});
