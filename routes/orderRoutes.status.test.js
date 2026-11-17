'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
const PostgresQuery=require('sequelize/lib/dialects/postgres/query');
const {prepareValue}=require('pg/lib/utils');

function makeHarness(order,options={}){
  const calls=[];
  const sqlCalls=[];
  const query=(table)=>{let values;return {
    select(){return this;}, update(nextValues){values=nextValues;calls.push({type:'update',table,values});return this;},
    eq(){return this;}, in(){return this;}, not(){return this;}, lt(){return this;},
    maybeSingle:async()=>({data:order,error:null}),
    single:async()=>({data:{...order,...values},error:null}),
    then(resolve,reject){return Promise.resolve({data:[],error:null}).then(resolve,reject);},
  };};
  const supabase={from:(table)=>query(table)};
  const express=require('express');
  const realLoad=Module._load;
  const stubs={
    '@supabase/supabase-js':{createClient:()=>supabase},
    '../middlewares/authMiddleware':{authenticateToken:(req,res,next)=>next()},
    '../middlewares/checkRole':{checkRole:()=> (req,res,next)=>next()},
    '../services/orderNotificationService':{notifyOrderStatusChanged:async()=>{}},
    '../services/activityLogger':{logActivity:async()=>{}},
    '../utils/otpHelper':{sendOrderConfirmationEmail:async()=>{}},
    '../services/stockService':{reduceStockForOrder:async(id)=>{calls.push({type:'deduct',id});return {success:true};},restoreStockForOrder:async()=>({success:true})},
    '../models/Product':{},
    '../services/internalFinance':{hideInternalOrderCosts:(v)=>v},
    '../config/database':{transaction:async(fn)=>fn({}),query:async(sql,queryOptions)=>{
      sqlCalls.push({sql,options:queryOptions});
      if(sql.includes('INSERT INTO public.orders'))return [[{id:'order-created',status:'pending_payment'}],{}];
      return [];
    }},
    '../services/orderCreationService':{createOrderWithItems:async(args)=>{
      if(options.exerciseOrderInserts){
        const transaction={};
        const orderRow=await args.insertOrder({transaction,initialStatus:args.initialStatus,orderData:{
          ...args.orderData,applied_promotion_ids:['00000000-0000-0000-0000-000000000001'],promotion_names:['Coupon YSF15','Automatic offer'],
        }});
        const itemsPayload=[{order_id:orderRow.id,product_id:'product-1',applied_promotion_ids:['00000000-0000-0000-0000-000000000001'],promotion_names:['Coupon YSF15']}];
        await args.insertItems({transaction,orderId:orderRow.id,items:itemsPayload});
        return {orderRow,itemsPayload,duplicate:false};
      }
      return options.creation||{};
    }},
    '../services/promotionCheckout':{calculatePromotionCheckout:async()=>({})},
    '../services/promotionRedemptionService':{transitionOrderReservations:async()=>{}},
  };
  Module._load=function(request,parent,isMain){if(Object.prototype.hasOwnProperty.call(stubs,request))return stubs[request];return realLoad.call(this,request,parent,isMain);};
  delete require.cache[require.resolve('./orderRoutes')];
  const router=require('./orderRoutes');
  Module._load=realLoad;
  return {router,calls,sqlCalls};
}

async function invoke(router,path,req){
  const layer=router.stack.find((entry)=>entry.route?.path===path);
  assert.ok(layer,`route ${path} exists`);
  const handlers=layer.route.stack.map((entry)=>entry.handle);
  const res={statusCode:200,body:null,status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}};
  let index=0;
  const next=async(error)=>{if(error)throw error;const handler=handlers[index++];if(handler)await handler(req,res,next);};
  await next();
  return res;
}

test('actual order status route blocks confirming an unpaid Paymob order',async()=>{
  const {router,calls}=makeHarness({id:'o1',user_id:'u1',status:'pending_payment',stock_status:null,payment_status:'initiated',payment_method:'card'});
  const res=await invoke(router,'/:id/status',{params:{id:'o1'},body:{status:'confirmed'},user:{id:'staff',role:'admin'}});
  assert.equal(res.statusCode,409);
  assert.equal(res.body.code,'PAYMENT_NOT_VERIFIED');
  assert.equal(calls.filter((call)=>call.type==='update').length,0);
});

test('actual order status route preserves COD confirmation',async()=>{
  const {router,calls}=makeHarness({id:'o2',user_id:'u1',status:'pending',stock_status:'done',payment_status:'pending',payment_method:'cod'});
  const res=await invoke(router,'/:id/status',{params:{id:'o2'},body:{status:'confirmed'},user:{id:'staff',role:'admin'}});
  assert.equal(res.statusCode,200);
  assert.equal(calls.filter((call)=>call.type==='update').length,1);
});

test('actual order status route blocks cancellation of paid Paymob orders',async()=>{
  const {router,calls}=makeHarness({id:'o3',user_id:'u1',status:'confirmed',stock_status:'done',payment_status:'paid',payment_method:'card'});
  const res=await invoke(router,'/:id/status',{params:{id:'o3'},body:{status:'cancelled'},user:{id:'staff',role:'admin'}});
  assert.equal(res.statusCode,409);
  assert.equal(res.body.code,'REFUND_REQUIRED');
  assert.equal(calls.filter((call)=>call.type==='update').length,0);
});

test('actual COD idempotent replay retries missing inventory deduction',async()=>{
  const order={id:'o4',user_id:'u1',status:'pending',payment_method:'cod',payment_status:'pending',stock_status:'failed',order_items:[],shipping_addresses:{}};
  const {router,calls}=makeHarness(order,{creation:{orderRow:{id:'o4',status:'pending'},itemsPayload:[],duplicate:true}});
  const res=await invoke(router,'/',{params:{},body:{shipping_address_id:'addr1',payment_method:'cod',idempotency_key:'key-1'},user:{id:'u1'},get:()=> 'key-1'});
  assert.equal(res.statusCode,200);
  assert.equal(calls.some((call)=>call.type==='deduct'&&call.id==='o4'),true);
  assert.equal(res.body.data.stock_status,'done');
});

test('actual checkout route binds the idempotency key under the SQL placeholder it uses',async()=>{
  const {router,sqlCalls}=makeHarness({id:'u1',role:'customer',status:'pending_payment'}, {
    creation:{orderRow:{id:'order-created',status:'pending_payment'},itemsPayload:[],duplicate:false},
  });
  const res=await invoke(router,'/',{
    params:{},
    body:{shipping_address_id:'addr1',payment_method:'card',idempotency_key:'checkout-key-42',items:[]},
    user:{id:'u1'},get:()=>null,
  });
  assert.equal(res.statusCode,201);
  const lookup=sqlCalls.find((call)=>call.sql.includes('checkout_idempotency_key'));
  assert.ok(lookup);
  assert.match(lookup.sql, /checkout_idempotency_key=:idempotencyKey/);
  assert.equal(lookup.options.replacements.idempotencyKey,'checkout-key-42');
});

test('actual checkout order and item inserts bind promotion UUID/text arrays correctly',async()=>{
  const {router,sqlCalls}=makeHarness({id:'u1',role:'customer'}, {exerciseOrderInserts:true});
  const res=await invoke(router,'/',{
    params:{},
    body:{shipping_address_id:'addr1',payment_method:'card',idempotency_key:'array-checkout-key',items:[],coupon_code:'YSF15'},
    user:{id:'u1'},get:()=>null,
  });
  assert.equal(res.statusCode,201);
  const orderInsert=sqlCalls.find((call)=>call.sql.includes('INSERT INTO public.orders'));
  const itemInsert=sqlCalls.find((call)=>call.sql.includes('INSERT INTO public.order_items'));
  for(const insert of [orderInsert,itemInsert]){
    assert.ok(insert);
    assert.match(insert.sql,/CAST\(\$applied_promotion_ids AS uuid\[\]\)/);
    assert.match(insert.sql,/CAST\(\$promotion_names AS text\[\]\)/);
    assert.deepEqual(insert.options.bind.applied_promotion_ids,['00000000-0000-0000-0000-000000000001']);
    const [boundSql,boundValues]=PostgresQuery.formatBindParameters(insert.sql,insert.options.bind,'postgres');
    assert.match(boundSql,/CAST\(\$\d+ AS uuid\[\]\)/);
    assert.ok(boundValues.some((value)=>Array.isArray(value)&&value[0]==='00000000-0000-0000-0000-000000000001'));
    assert.equal(prepareValue(insert.options.bind.applied_promotion_ids),'{"00000000-0000-0000-0000-000000000001"}');
  }
});
