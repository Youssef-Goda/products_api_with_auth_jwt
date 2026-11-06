'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOrderWithItems } = require('./orderCreationService');

function fixture({ products = [], lookupError = null, itemInsertError = null } = {}) {
  let committed = { orders: [], items: [] };
  const sequelize = {
    async transaction(callback) {
      const staged = { orders: [], items: [] };
      const result = await callback(staged);
      committed = staged;
      return result;
    },
  };
  const Product = {
    async findAll({ where, transaction }) {
      assert.ok(transaction);
      if (lookupError) throw lookupError;
      return products.filter((product) => where.id.includes(product.id));
    },
  };
  const callbacks = {
    insertOrder: async ({ transaction }) => {
      transaction.orders.push({ id: 'order-1' });
      return { id: 'order-1' };
    },
    insertItems: async ({ transaction, items }) => {
      if (itemInsertError) throw itemInsertError;
      transaction.items.push(...items);
    },
  };
  return {
    readCommitted: () => committed,
    create: (items) => createOrderWithItems({
      sequelize, Product, orderData: {}, initialStatus: 'pending', items, ...callbacks,
    }),
  };
}

const orderItems = [
  { product_id: 'known', unit_price: 50, quantity: 2, subtotal: 100, unit_cost_snapshot: 999 },
  { product_id: 'unknown-cost', unit_price: 10, quantity: 1, subtotal: 10 },
];

test('stores database cost snapshots and preserves unknown costs as NULL', async () => {
  const db = fixture({ products: [
    { id: 'known', costPrice: '21.25' },
    { id: 'unknown-cost', costPrice: null },
  ] });
  await db.create(orderItems);
  const saved = db.readCommitted().items;
  assert.equal(saved[0].unit_cost_snapshot, 21.25);
  assert.equal(saved[1].unit_cost_snapshot, null);
  assert.notEqual(saved[0].unit_cost_snapshot, 999); // Never accepts a client cost.
});

test('a product lookup failure leaves no order or items committed', async () => {
  const db = fixture({ lookupError: new Error('lookup failed') });
  await assert.rejects(db.create(orderItems), /lookup failed/);
  assert.deepEqual(db.readCommitted(), { orders: [], items: [] });
});

test('a missing product rolls back the newly inserted order', async () => {
  const db = fixture({ products: [{ id: 'known', costPrice: 3 }] });
  await assert.rejects(db.create(orderItems), /do not exist/);
  assert.deepEqual(db.readCommitted(), { orders: [], items: [] });
});

test('an order item insert failure rolls back its order row', async () => {
  const db = fixture({
    products: [{ id: 'known', costPrice: 3 }, { id: 'unknown-cost', costPrice: null }],
    itemInsertError: new Error('item insert failed'),
  });
  await assert.rejects(db.create(orderItems), /item insert failed/);
  assert.deepEqual(db.readCommitted(), { orders: [], items: [] });
});

test('later product cost changes do not alter saved order snapshots', async () => {
  const products = [{ id: 'known', costPrice: 12.5 }];
  const db = fixture({ products });
  await db.create([orderItems[0]]);
  products[0].costPrice = 99;
  assert.equal(db.readCommitted().items[0].unit_cost_snapshot, 12.5);
});
