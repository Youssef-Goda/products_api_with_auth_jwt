'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calculateCartProfitability } = require('./cartProfitability');

const calculate = (args, storedCosts = {}) => calculateCartProfitability({
  ...args,
  costLookup: async (ids) => ids.map((id) => ({
    id,
    costPrice: Object.prototype.hasOwnProperty.call(storedCosts, id) ? storedCosts[id] : null,
  })),
});

test('allocates a cart discount proportionally over multiple eligible products', async () => {
  const result = await calculate({
    cartDiscount: '5.00',
    items: [
      { productId: 'a', unitPrice: '10.00', quantity: 1 },
      { productId: 'b', unitPrice: '20.00', quantity: 1 },
    ],
  }, { a: '4.00', b: '12.00' });
  assert.deepEqual(result.items.map((item) => item.cartDiscount), [1.67, 3.33]);
  assert.equal(result.allocatedCartDiscount, 5);
  assert.equal(result.allocatedCartDiscountCents, result.cartDiscountCents);
  assert.equal(result.items[0].effectiveSubtotal, 8.33);
  assert.equal(result.items[1].grossProfit, 4.67);
});

test('does not allocate a cart discount to ineligible items', async () => {
  const result = await calculate({
    cartDiscount: 2,
    items: [
      { productId: 'a', unitPrice: 10, quantity: 1, eligibleForCartDiscount: false },
      { productId: 'b', unitPrice: 10, quantity: 1 },
    ],
  }, { a: 5, b: 5 });
  assert.deepEqual(result.items.map((item) => item.cartDiscount), [0, 2]);
});

test('zero-value eligible items receive no share and do not disturb reconciliation', async () => {
  const result = await calculate({
    cartDiscount: 2,
    items: [
      { productId: 'zero', unitPrice: 0, quantity: 4 },
      { productId: 'positive', unitPrice: 5, quantity: 1 },
    ],
  }, { zero: 0, positive: 2 });
  assert.deepEqual(result.items.map((item) => item.cartDiscount), [0, 2]);
  assert.equal(result.allocatedCartDiscountCents, 200);
});

test('respects quantity and computes average effective unit price', async () => {
  const result = await calculate({
    cartDiscount: 1,
    items: [{ productId: 'a', unitPrice: 10, quantity: 3 }],
  }, { a: 2 });
  assert.equal(result.items[0].effectiveSubtotal, 29);
  assert.equal(result.items[0].effectiveUnitPrice, 29 / 3);
  assert.equal(result.items[0].grossProfit, 23);
});

test('allocates odd cents deterministically and reconciles exactly', async () => {
  const result = await calculate({
    cartDiscount: '0.01',
    items: [
      { productId: 'a', unitPrice: 1, quantity: 1 },
      { productId: 'b', unitPrice: 1, quantity: 1 },
    ],
  }, { a: null, b: 0.5 });
  assert.deepEqual(result.items.map((item) => item.cartDiscount), [0.01, 0]);
  assert.equal(result.allocatedCartDiscount, result.cartDiscount);
});

test('unknown stored cost yields unknown profitability, not zero cost', async () => {
  const item = (await calculate({
    cartDiscount: 1,
    items: [{ productId: 'a', unitPrice: 10, quantity: 1 }],
  }, { a: null })).items[0];
  assert.equal(item.unitCost, null);
  assert.equal(item.grossProfit, null);
  assert.equal(item.grossMargin, null);
  assert.equal(item.isBelowCost, null);
});

test('rejects discounts beyond eligible totals and over-discounted product lines', async () => {
  await assert.rejects(calculate({ cartDiscount: 1.01, items: [{ productId: 'a', unitPrice: 1, quantity: 1 }] }, { a: 0 }), /exceeds eligible/);
  await assert.rejects(calculate({ cartDiscount: 0, items: [{ productId: 'a', unitPrice: 1, quantity: 1, productDiscount: 1.01 }] }, { a: 0 }), /exceeds its subtotal/);
});

test('product discounts reduce cart discount weights and are not counted twice', async () => {
  const result = await calculate({
    cartDiscount: 3,
    items: [
      { productId: 'a', unitPrice: 10, quantity: 1, productDiscount: 2 },
      { productId: 'b', unitPrice: 10, quantity: 1 },
    ],
  }, { a: 4, b: 5 });
  assert.deepEqual(result.items.map((item) => item.cartDiscount), [1.33, 1.67]);
  assert.deepEqual(result.items.map((item) => item.totalDiscount), [3.33, 1.67]);
  assert.equal(result.totalDiscount, 5);
  assert.equal(result.items[0].grossProfit, 2.67);
});

test('ignores client-submitted unit costs and loads the stored product costs', async () => {
  const result = await calculateCartProfitability({
    items: [{ productId: 'a', unitPrice: 10, quantity: 1, unitCost: 0 }],
    cartDiscount: 0,
    costLookup: async () => [{ id: 'a', costPrice: 7 }],
  });
  assert.equal(result.items[0].unitCost, 7);
  assert.equal(result.items[0].grossProfit, 3);
});

test('order snapshot mode uses persisted historical unit cost instead of current product cost', async () => {
  const result = await calculateCartProfitability({
    costBasis: 'orderSnapshot',
    cartDiscount: 0,
    items: [{ product_id: 'a', unit_price: '10.00', quantity: 1, unit_cost_snapshot: '6.00' }],
    costLookup: async () => { throw new Error('current product cost must not be read'); },
  });
  assert.equal(result.items[0].unitCost, 6);
  assert.equal(result.items[0].grossProfit, 4);
});
