'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {cancellationBlock,customerCancellationBlock}=require('./orderPaymentPolicy');

test('paid or reconciliation-required orders cannot be cancelled by customers or admins',()=>{
  for(const payment_status of ['paid','reconciliation_required']){
    const order={id:'o1',user_id:'u1',status:'confirmed',payment_status};
    assert.equal(customerCancellationBlock(order,'u1').code,'REFUND_REQUIRED');
    assert.equal(cancellationBlock(order,'cancelled').code,'REFUND_REQUIRED');
  }
});
test('refund status cannot be asserted without a verified refund workflow',()=>{
  assert.equal(cancellationBlock({payment_status:'paid'},'refunded').code,'VERIFIED_REFUND_REQUIRED');
});
test('unpaid pending COD checkout retains the existing self-cancellation behavior',()=>{
  assert.equal(customerCancellationBlock({user_id:'u1',status:'pending',payment_status:'pending'},'u1'),null);
  assert.equal(customerCancellationBlock({user_id:'u2',status:'pending',payment_status:'pending'},'u1').status,403);
});
