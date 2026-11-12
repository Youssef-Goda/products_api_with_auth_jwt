'use strict';
const {QueryTypes}=require('sequelize');
const {validatePaymobOrder}=require('./paymobPaymentPolicy');

async function reservePaymobAttempt({sequelize,orderId,userId,method,requestKey,now=new Date()}){
  return sequelize.transaction(async(transaction)=>{
    const order=(await sequelize.query('SELECT id,user_id,status,payment_status,payment_method,total,applied_promotion_ids,payment_expires_at FROM public.orders WHERE id=:id FOR UPDATE',{type:QueryTypes.SELECT,transaction,replacements:{id:orderId}}))[0];
    const validation=validatePaymobOrder(order,userId,method);
    if(!validation.ok)return {error:validation};
    method=validation.method;
    let active=(await sequelize.query("SELECT * FROM public.paymob_payment_attempts WHERE order_id=:orderId AND status IN ('initializing','initiated','reconciliation_required') FOR UPDATE",{type:QueryTypes.SELECT,transaction,replacements:{orderId}}))[0];
    if(active?.status==='initiated'&&active.expires_at&&new Date(active.expires_at)<=now&&(!order.payment_expires_at||new Date(order.payment_expires_at)<=now)){
      await sequelize.query("UPDATE public.paymob_payment_attempts SET status='expired',updated_at=now() WHERE id=:id AND status='initiated'",{transaction,replacements:{id:active.id}});
      await sequelize.query("UPDATE public.orders SET payment_status='pending',payment_expires_at=NULL,updated_at=now() WHERE id=:id AND payment_status='initiated' AND payment_expires_at<=now()",{transaction,replacements:{id:orderId}});
      order.payment_status='pending';
      active=null;
    }
    if(active){
      if(active.status==='initiated'&&active.payment_method===method&&active.client_secret&&Number(active.amount_cents)===validation.amountCents)return {attempt:active,replay:true,order};
      return {error:{ok:false,status:409,message:'A payment attempt is already active for this order. Please resume it or contact support.'}};
    }
    if(order.payment_status==='initiated')return {error:{ok:false,status:409,message:'The existing payment attempt must be reconciled before another attempt.'}};
    const previous=(await sequelize.query('SELECT * FROM public.paymob_payment_attempts WHERE order_id=:orderId AND request_key=:requestKey FOR UPDATE',{type:QueryTypes.SELECT,transaction,replacements:{orderId,requestKey}}))[0];
    if(previous&&['failed','expired'].includes(previous.status)){
      const attempt=(await sequelize.query("UPDATE public.paymob_payment_attempts SET status='initializing',payment_method=:method,amount_cents=:amount,provider_intention_id=NULL,client_secret=NULL,expires_at=NULL,provider_transaction_id=NULL,provider_result='{}'::jsonb,updated_at=now() WHERE id=:id RETURNING *",{type:QueryTypes.SELECT,transaction,replacements:{id:previous.id,method,amount:validation.amountCents}}))[0];
      return {attempt,replay:false,order};
    }
    const id=require('node:crypto').randomUUID();
    const attempt=(await sequelize.query(`INSERT INTO public.paymob_payment_attempts(id,order_id,user_id,request_key,status,payment_method,amount_cents)
      VALUES(:id,:orderId,:userId,:requestKey,'initializing',:method,:amount) RETURNING *`,{type:QueryTypes.SELECT,transaction,replacements:{id,orderId,userId,requestKey,method,amount:validation.amountCents}}))[0];
    return {attempt,replay:false,order};
  });
}

module.exports={reservePaymobAttempt};
