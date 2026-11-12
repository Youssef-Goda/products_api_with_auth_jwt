'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');

function stockHarness(initialStock=10){
  let state={stock:{p1:initialStock},ledger:[]};
  let queue=Promise.resolve();
  const items=[{product_id:'p1',product_name:'Product',quantity:2}];
  const supabase={from:()=>({select(){return this;},eq:async()=>({data:items,error:null})})};
  const sequelize={literal:(sql)=>sql,transaction:async()=>{
    const previous=queue;let unlock;queue=new Promise((resolve)=>{unlock=resolve;});await previous;
    const local={stock:{...state.stock},ledger:state.ledger.map((row)=>({...row}))};
    return {local,commit:async()=>{state=local;unlock();},rollback:async()=>{unlock();}};
  },query:async(sql,{transaction,replacements})=>{
    const rows=transaction.local.ledger;
    if(sql.includes('INSERT INTO public.inventory_stock_movements')){
      if(rows.some((row)=>row.order_id===replacements.orderId&&row.product_id===replacements.productId&&row.action===replacements.action))return [[],{}];
      const row={id:rows.length+1,order_id:replacements.orderId,product_id:replacements.productId,action:replacements.action,quantity:replacements.quantity};rows.push(row);return [[row],{}];
    }
    if(sql.includes('SELECT quantity FROM public.inventory_stock_movements')){
      const row=rows.find((item)=>item.order_id===replacements.orderId&&item.product_id===replacements.productId&&item.action===(sql.includes("action='deduct'")?'deduct':replacements.action));
      return [row?[row]:[],{}];
    }
    throw new Error(`Unmocked SQL: ${sql}`);
  }};
  const Product={update:async(values,{where,transaction})=>{
    const current=transaction.local.stock[where.id];if(current===undefined)return [0];
    if(where.countInStock&&current<where.countInStock[require('sequelize').Op.gte])return [0];
    const amount=Number(values.countInStock.match(/\d+/)[0]);
    transaction.local.stock[where.id]=values.countInStock.includes(' - ')?current-amount:current+amount;
    return [1];
  }};
  const realLoad=Module._load;
  Module._load=function(request,parent,isMain){
    if(request==='@supabase/supabase-js')return {createClient:()=>supabase};
    if(request==='../config/database'&&parent?.filename?.endsWith('/services/stockService.js'))return sequelize;
    if(request==='../models/Product'&&parent?.filename?.endsWith('/services/stockService.js'))return Product;
    return realLoad.call(this,request,parent,isMain);
  };
  delete require.cache[require.resolve('./stockService')];
  const service=require('./stockService');Module._load=realLoad;
  return {service,get state(){return state;}};
}

test('restoration is idempotent after a committed movement and lost response',async()=>{
  const h=stockHarness(8);
  const deduction=await h.service.reduceStockForOrder('o1');assert.equal(deduction.success,true,JSON.stringify(deduction));
  assert.equal(h.state.ledger[0].action,'deduct',JSON.stringify(h.state));
  assert.equal(h.state.stock.p1,6);
  assert.equal((await h.service.restoreStockForOrder('o1')).success,true);
  assert.equal((await h.service.restoreStockForOrder('o1')).success,true);
  assert.equal(h.state.stock.p1,8);
  assert.equal(h.state.ledger.filter((row)=>row.action==='restore').length,1);
});

test('concurrent restoration calls do not increase stock twice',async()=>{
  const h=stockHarness(8);await h.service.reduceStockForOrder('o2');
  const results=await Promise.all([h.service.restoreStockForOrder('o2'),h.service.restoreStockForOrder('o2')]);
  assert.ok(results.every((result)=>result.success));
  assert.equal(h.state.stock.p1,8);
  assert.equal(h.state.ledger.filter((row)=>row.action==='restore').length,1);
});

test('failed deduction rolls the movement claim and stock update back together',async()=>{
  const h=stockHarness(1);
  const result=await h.service.reduceStockForOrder('o3');
  assert.equal(result.success,false);
  assert.equal(h.state.stock.p1,1);
  assert.equal(h.state.ledger.length,0);
});
