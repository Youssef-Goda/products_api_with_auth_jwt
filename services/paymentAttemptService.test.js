'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {reservePaymobAttempt}=require('./paymentAttemptService');

function fixture(){
  const state={order:{id:'order-1',user_id:'user-1',status:'pending_payment',payment_status:'pending',payment_method:'card',total:'10.00',payment_expires_at:null},attempts:[]};
  let tail=Promise.resolve();
  const sequelize={
    async transaction(callback){const previous=tail;let release;tail=new Promise(resolve=>release=resolve);await previous;try{return await callback({});}finally{release();}},
    async query(sql,{replacements={}}={}){
      if(sql.includes('SELECT id,user_id,status,payment_status'))return [state.order];
      if(sql.includes('SELECT * FROM public.paymob_payment_attempts WHERE order_id=:orderId AND status'))return state.attempts.filter(a=>['initializing','initiated','reconciliation_required'].includes(a.status));
      if(sql.includes('SELECT * FROM public.paymob_payment_attempts WHERE order_id=:orderId AND request_key'))return state.attempts.filter(a=>a.request_key===replacements.requestKey);
      if(sql.includes('INSERT INTO public.paymob_payment_attempts')){const row={...replacements,status:'initializing'};state.attempts.push(row);return [row];}
      if(sql.includes("SET status='expired'")){const row=state.attempts.find(a=>a.id===replacements.id);if(row)row.status='expired';return [];}
      if(sql.includes("SET payment_status='pending'")){state.order.payment_status='pending';return [];}
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return {sequelize,state};
}

test('concurrent initiation attempts reserve at most one attempt and retries resume the same intention',async()=>{
  const f=fixture();
  const args={sequelize:f.sequelize,orderId:'order-1',userId:'user-1',method:'card',requestKey:'same-request'};
  const results=await Promise.all([reservePaymobAttempt(args),reservePaymobAttempt(args)]);
  assert.equal(f.state.attempts.length,1);
  assert.equal(results.filter(result=>result.attempt).length,1);
  assert.equal(results.filter(result=>result.error?.status===409).length,1);
  const stored=f.state.attempts[0];
  stored.status='initiated';stored.client_secret='resume-secret';stored.amount_cents=1000;stored.payment_method='card';
  const retry=await reservePaymobAttempt(args);
  assert.equal(retry.replay,true);
  assert.equal(retry.attempt.id,stored.id);
});
