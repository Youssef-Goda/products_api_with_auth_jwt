'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePromotionFinancials } = require('./promotionFinancials');

const products = [
  { id: 'a', price: 100, costPrice: 60, categoryId: 'ca' },
  { id: 'b', price: 50, costPrice: 45, categoryId: 'cb' },
  { id: 'c', price: 20, costPrice: 2, categoryId: 'cc' },
];
const lookup = async (ids) => ids.map((id) => {
  const p = products.find((item) => item.id === id);
  return { id, costPrice: p?.costPrice ?? null };
});

test('percentage promotion calculates aggregate gross margin and reports item losses separately', async () => {
  const result = await calculatePromotionFinancials({ promotion: { discount_type: 'percentage', discount_value: 10, eligible_product_ids: ['a','b'] }, products, costLookup: lookup });
  assert.equal(result.costKnown, true);
  assert.equal(result.effectiveRevenue, 135);
  assert.equal(result.grossProfit, 30);
  assert.equal(result.grossMargin, 22.2222);
  assert.equal(result.lossMaking, false);
});

test('fixed coupon caps at eligible subtotal and retains known costs', async () => {
  const result = await calculatePromotionFinancials({ promotion: { discount_type: 'fixed', discount_value: 20, eligible_product_ids: ['a'] }, products, costLookup: lookup });
  assert.equal(result.effectiveRevenue, 80);
  assert.equal(result.grossProfit, 20);
});

test('unknown product cost never becomes zero or fabricated profit', async () => {
  const result = await calculatePromotionFinancials({ promotion: { discount_type: 'percentage', discount_value: 5, eligible_product_ids: ['a'] }, products: [{ ...products[0], costPrice: null }], costLookup: async (ids) => ids.map((id) => ({ id, costPrice: null })) });
  assert.equal(result.costKnown, false);
  assert.equal(result.grossProfit, null);
  assert.equal(result.grossMargin, null);
});

test('below-cost promotion reports loss and configured margin threshold', async () => {
  const result = await calculatePromotionFinancials({ promotion: { discount_type: 'percentage', discount_value: 60, eligible_product_ids: ['a'] }, products, threshold: 20, costLookup: lookup });
  assert.equal(result.grossProfit, -20);
  assert.equal(result.expectedLoss, 20);
  assert.equal(result.lossMaking, true);
});

test('a loss-making eligible product is not hidden by positive aggregate gross profit',async()=>{
  const mixed=[{id:'loss',price:100,costPrice:101},{id:'winner',price:200,costPrice:10}];
  const result=await calculatePromotionFinancials({promotion:{discount_type:'percentage',discount_value:10,eligible_product_ids:['loss','winner']},products:mixed});
  assert.ok(result.grossProfit>0);
  assert.equal(result.lossMaking,true);
  assert.deepEqual(result.itemLosses,[{productId:'loss',grossLoss:11}]);
});

test('zero effective selling price remains an explicit loss, not an undefined safe margin', async () => {
  const free = [{ id:'free', price:0, costPrice:12, categoryId:'c' }];
  const result = await calculatePromotionFinancials({ promotion:{discount_type:'fixed',discount_value:20,eligible_product_ids:['free']},products:free,costLookup:async ids=>ids.map(id=>({id,costPrice:12})) });
  assert.equal(result.grossMargin, null);
  assert.equal(result.lossMaking, true);
  assert.equal(result.expectedLoss, 12);
});

test('category eligibility excludes products outside configured scope', async () => {
  const result = await calculatePromotionFinancials({ promotion:{discount_type:'percentage',discount_value:5,eligible_category_ids:['ca']},products,costLookup:lookup });
  assert.equal(result.eligibleProductCount,1);
  assert.equal(result.grossProfit,35);
});
