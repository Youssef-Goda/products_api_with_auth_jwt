'use strict';
function cancellationBlock(order,targetStatus){
  if(targetStatus==='refunded')return {status:409,code:'VERIFIED_REFUND_REQUIRED',message:'A refund status can only be recorded after a verified refund workflow confirms it.'};
  if(targetStatus==='cancelled'&&['paid','reconciliation_required'].includes(String(order?.payment_status||'')))return {status:409,code:'REFUND_REQUIRED',message:'This order has been paid or requires payment reconciliation. Contact support; cancellation requires a verified refund workflow.'};
  return null;
}
function customerCancellationBlock(order,userId){
  if(String(order?.user_id)!==String(userId))return {status:403,message:'You are not authorized to cancel this order.'};
  if(['paid','reconciliation_required'].includes(String(order?.payment_status||'')))return cancellationBlock(order,'cancelled');
  if(!['pending','confirmed'].includes(String(order?.status||'')))return {status:400,message:`Cannot cancel an order that is already "${order?.status}". Only pending or confirmed orders can be cancelled.`};
  return null;
}
module.exports={cancellationBlock,customerCancellationBlock};
