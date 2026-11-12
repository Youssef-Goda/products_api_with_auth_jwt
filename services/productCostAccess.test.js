'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { canManageProductCost, serializePublicProduct, serializeInternalProduct } = require('./productCostAccess');

test('only the existing owner role can view or update cost', () => {
  assert.equal(canManageProductCost('owner'), true);
  assert.equal(canManageProductCost('admin'), false);
  assert.equal(canManageProductCost('reviewer'), false);
  assert.equal(canManageProductCost('customer'), false);
});

test('public product serialization removes cost and derived profitability', () => {
  const result = serializePublicProduct({
    id: 'p1', price: 50, costPrice: 20, grossProfit: 30, grossMargin: 60, isBelowCost: false,
  });
  assert.deepEqual(result, { id: 'p1', price: 50 });
});

test('internal serialization preserves NULL as unknown and calculates known cost', () => {
  assert.equal(serializeInternalProduct({ id: 'unknown', price: 50, costPrice: null }).grossProfit, null);
  const known = serializeInternalProduct({ id: 'known', price: 50, costPrice: 20 });
  assert.equal(known.grossProfit, 30);
  assert.equal(known.grossMargin, 60);
});
