'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPromotionFinancials, promotionFinancialFingerprint } = require('./promotionApprovalPolicy');

const promotion = { discount_type:'percentage', discount_value:20, max_discount:null, eligible_product_ids:[], eligible_category_ids:['c1'], excluded_product_ids:['excluded'], excluded_category_ids:[] };
const product = (id, price, cost, categoryId='c1') => ({id,price,costPrice:cost,categoryId});

test('classifies an individually loss-making eligible item as owner-only despite a profitable aggregate', () => {
  assert.equal(classifyPromotionFinancials({costKnown:true,grossProfit:30,grossMargin:15,lossMaking:true,expectedLoss:5},20),'owner_loss');
});
test('unknown costs never pass the financial gate', () => {
  assert.equal(classifyPromotionFinancials({costKnown:false,grossProfit:null,grossMargin:null},20),'unverifiable');
});
test('below-threshold non-loss margin requires two roles', () => {
  assert.equal(classifyPromotionFinancials({costKnown:true,grossProfit:2,grossMargin:8,lossMaking:false},20),'manager_and_owner');
});
test('fingerprint changes when an affected price or cost changes, not for excluded or unrelated products', () => {
  const baseline=[product('a',100,60),product('excluded',50,10),product('outside',20,10,'c2')];
  const fp=promotionFinancialFingerprint(promotion,baseline,20);
  assert.notEqual(promotionFinancialFingerprint(promotion,[product('a',101,60),...baseline.slice(1)],20),fp);
  assert.notEqual(promotionFinancialFingerprint(promotion,[product('a',100,61),...baseline.slice(1)],20),fp);
  assert.equal(promotionFinancialFingerprint(promotion,[product('a',100,60),product('excluded',50,11),product('outside',21,10,'c2')],20),fp);
});
