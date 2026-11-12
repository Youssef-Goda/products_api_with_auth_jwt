'use strict';

function normalizePaymobMethod(value) {
  const method=String(value||'card').toLowerCase();
  return method==='online'?'card':method;
}

function validatePaymobOrder(order, userId, requestedMethod) {
  if (!order) return {ok:false,status:404,message:'Order not found.'};
  if (String(order.user_id)!==String(userId)) return {ok:false,status:403,message:'Access denied to this order.'};
  const method=normalizePaymobMethod(requestedMethod);
  const saved=String(order.payment_method||'').toLowerCase();
  if (!['card','wallet','cash'].includes(saved)||saved!==method) return {ok:false,status:409,message:'This order is not payable with the selected online payment method.'};
  if (['cancelled','refunded','expired'].includes(String(order.status||'').toLowerCase())) return {ok:false,status:409,message:'This order is no longer payable.'};
  if (!['pending','initiated'].includes(String(order.payment_status||'').toLowerCase())) return {ok:false,status:409,message:'This order is not awaiting payment.'};
  const amount=Number(order.total);
  if (!Number.isFinite(amount)||amount<=0) return {ok:false,status:409,message:'This order has no valid payable amount.'};
  const amountCents=Math.round(amount*100);
  if(!Number.isSafeInteger(amountCents)||amountCents<=0)return {ok:false,status:409,message:'This order has no valid payable amount.'};
  return {ok:true,method,amountCents};
}

function lateSuccessRequiresReconciliation(order) {
  return ['cancelled','refunded','expired'].includes(String(order?.status||'').toLowerCase());
}

module.exports={normalizePaymobMethod,validatePaymobOrder,lateSuccessRequiresReconciliation};
