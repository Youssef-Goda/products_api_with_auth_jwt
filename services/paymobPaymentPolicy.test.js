'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validatePaymobOrder,lateSuccessRequiresReconciliation}=require('./paymobPaymentPolicy');

const base={id:'o1',user_id:'u1',status:'pending_payment',payment_status:'pending',payment_method:'card',total:'110.00'};
test('COD and method mismatch cannot be turned into Paymob payment',()=>{
  assert.equal(validatePaymobOrder({...base,payment_method:'cod'},'u1','card').ok,false);
  assert.equal(validatePaymobOrder(base,'u1','wallet').ok,false);
});
test('cancelled and expired orders cannot start payment',()=>{
  for(const status of ['cancelled','expired','refunded']) assert.equal(validatePaymobOrder({...base,status},'u1','card').ok,false);
});
test('ownership, payment status, and payable amount are checked',()=>{
  assert.equal(validatePaymobOrder(base,'u2','card').status,403);
  assert.equal(validatePaymobOrder({...base,payment_status:'paid'},'u1','card').ok,false);
  assert.equal(validatePaymobOrder({...base,total:0},'u1','card').ok,false);
  assert.deepEqual(validatePaymobOrder(base,'u1','card'),{ok:true,method:'card',amountCents:11000});
});
test('a late verified success on a terminal order routes to reconciliation',()=>{
  assert.equal(lateSuccessRequiresReconciliation({...base,status:'cancelled'}),true);
  assert.equal(lateSuccessRequiresReconciliation(base),false);
});
