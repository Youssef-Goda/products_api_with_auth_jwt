'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {promotionDto}=require('./promotionResponsePolicy');

test('Admin promotion DTO strips financial fields recursively including approvals and invalidation details',()=>{
  const source={margin_snapshot:2,financial:{expectedLoss:4,financialFingerprint:'secret'},approvals:[{financial_snapshot:{cost:8},reason:'owner reason'}],promotion:{profit_snapshot:3},invalidatedPromotions:[{expected_loss:9}],name:'Sale'};
  const result=promotionDto(source,'admin');
  assert.deepEqual(result,{promotion:{},invalidatedPromotions:[{}],name:'Sale'});
  assert.equal(source.margin_snapshot,2); // serializer does not mutate model data
});

test('Owner and Manager receive their authorized finance DTO unchanged',()=>{
  const row={margin_snapshot:22,expected_loss:0};
  assert.equal(promotionDto(row,'owner'),row);
  assert.equal(promotionDto(row,'manager'),row);
});
