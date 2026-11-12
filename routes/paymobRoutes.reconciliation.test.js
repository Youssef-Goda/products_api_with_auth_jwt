'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('node:module');
function loadRouter(role='manager'){
  const queries=[];
  const sequelize={query:async(sql,options)=>{queries.push({sql,options});if(sql.includes('count(*)'))return [{count:1}];if(sql.includes('INSERT INTO public.paymob_attempt_reviews'))return [{id:'r1',attempt_id:'a1',previous_status:'reconciliation_required',resulting_status:'reconciliation_required'}];if(sql.includes('SELECT id,order_id,status FROM public.paymob_payment_attempts'))return [{id:'a1',order_id:'o1',status:'reconciliation_required'}];return [{attempt_reference:'a1',order_reference:'o1',status:'reconciliation_required',provider_transaction_id:'tx-safe'}];},transaction:async(fn)=>fn({})};
  const User={findByPk:async()=>({id:'staff1',role,isActive:true})};
  const realLoad=Module._load;
  Module._load=function(request,parent,isMain){
    if(request==='../config/database'&&parent?.filename?.endsWith('/routes/paymobRoutes.js'))return sequelize;
    if(request==='../models/User'&&parent?.filename?.endsWith('/routes/paymobRoutes.js'))return User;
    if(request==='sequelize')return {...realLoad.call(this,request,parent,isMain),QueryTypes:{SELECT:'SELECT',INSERT:'INSERT'}};
    if(request==='../middlewares/authMiddleware'&&parent?.filename?.endsWith('/routes/paymobRoutes.js'))return {authenticateToken:(req,res,next)=>next()};
    if(request==='../controllers/paymobController'&&parent?.filename?.endsWith('/routes/paymobRoutes.js'))return {initiatePayment(){},handleWebhook(){},handleCallback(){}};
    return realLoad.call(this,request,parent,isMain);
  };
  delete require.cache[require.resolve('./paymobRoutes')];const router=require('./paymobRoutes');Module._load=realLoad;
  return {router,queries};
}
async function invoke(router,path,method,req){
  const layer=router.stack.find((entry)=>entry.route?.path===path&&entry.route.methods[method]);assert.ok(layer);
  const handlers=layer.route.stack.map((entry)=>entry.handle);const res={statusCode:200,body:null,headers:{},status(n){this.statusCode=n;return this;},json(v){this.body=v;return this;},header(k,v){this.headers[k]=v;return this;}};
  let i=0;const next=async(error)=>{if(error)throw error;const handler=handlers[i++];if(handler)await handler(req,res,next);};await next();return res;
}
test('unresolved attempt listing is available to Manager and omits secret fields',async()=>{
  const {router}=loadRouter('manager');const res=await invoke(router,'/reconciliation/attempts','get',{user:{id:'staff1'},query:{page:'1',pageSize:'10'},headers:{}});
  assert.equal(res.statusCode,200);assert.equal(res.body.data[0].attempt_reference,'a1');assert.equal('client_secret' in res.body.data[0],false);assert.equal('hmac' in res.body.data[0],false);
});
test('unresolved attempt listing denies Admin',async()=>{
  const {router}=loadRouter('admin');const res=await invoke(router,'/reconciliation/attempts','get',{user:{id:'staff1'},query:{},headers:{}});
  assert.equal(res.statusCode,403);
});
test('manual review records a note without changing payment state',async()=>{
  const {router,queries}=loadRouter('owner');const res=await invoke(router,'/reconciliation/attempts/:id/review','post',{user:{id:'staff1'},params:{id:'a1'},body:{reason:'Compared to provider dashboard',evidenceReference:'case-123'},headers:{}});
  assert.equal(res.statusCode,201);assert.match(res.body.message,/remains unresolved/);assert.equal(queries.some(({sql})=>/UPDATE public\.(orders|paymob_payment_attempts)/i.test(sql)),false);
});
test('review history is exposed to authorized reviewers without payment secrets',async()=>{
  const {router}=loadRouter('owner');const res=await invoke(router,'/reconciliation/attempts/:id/reviews','get',{user:{id:'staff1'},params:{id:'a1'},query:{},headers:{}});
  assert.equal(res.statusCode,200);assert.equal('client_secret' in res.body.data[0],false);assert.equal('hmac' in res.body.data[0],false);
});
