'use strict';
function orderStatusTransitionBlock(order, nextStatus) {
  if (nextStatus === 'confirmed' && ['card','wallet','cash','fawry','online','paymob'].includes(String(order?.payment_method || '').toLowerCase()) && String(order?.payment_status || '').toLowerCase() !== 'paid') {
    return { status: 409, code: 'PAYMENT_NOT_VERIFIED', message: 'A Paymob order can be confirmed only after its verified payment webhook succeeds.' };
  }
  return null;
}
module.exports = { orderStatusTransitionBlock };
