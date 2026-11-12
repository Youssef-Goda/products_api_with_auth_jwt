'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
function load(role,target){
  const updates=[];const User={findByPk:async(id)=>id==='actor'?{id,role,isActive:true}:target,update:async(values)=>updates.push(values)};
  const real=Module._load;Module._load=function(request,parent,isMain){
    if(request==='../models/User'&&parent?.filename?.endsWith('/routes/userRoutes.js'))return User;
    if(request==='../config/database'&&parent?.filename?.endsWith('/routes/userRoutes.js'))return {};
    if(request==='../middlewares/authMiddleware'&&parent?.filename?.endsWith('/routes/userRoutes.js'))return {authenticateToken:(req,res,next)=>next()};
    if(request==='../middlewares/checkRole'&&parent?.filename?.endsWith('/routes/userRoutes.js'))return {checkRole:()=> (req,res,next)=>next(),ownerPrivilege:(req,res,next)=>next()};
    if(request==='../utils/otpHelper'&&parent?.filename?.endsWith('/routes/userRoutes.js'))return {sendOTP:async()=>{}};
    if(request==='../services/activityLogger'&&parent?.filename?.endsWith('/routes/userRoutes.js'))return {logActivity:async()=>{}};
    return real.call(this,request,parent,isMain);
  };delete require.cache[require.resolve('./userRoutes')];const router=require('./userRoutes');Module._load=real;return {router,updates};
}
async function invoke(router,path,method,req){const layer=router.stack.find(x=>x.route?.path===path&&x.route.methods[method]);assert.ok(layer);const hs=layer.route.stack.map(x=>x.handle);const res={statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};let i=0;const next=async(e)=>{if(e)throw e;const fn=hs[i++];if(fn)await fn(req,res,next);};await next();return res;}
test('actual role update route denies Admin grants of Admin, Manager, and Owner',async()=>{
  for(const role of ['admin','manager','owner']){const h=load('admin',{id:'target',role:'customer',email:'x'});const res=await invoke(h.router,'/update-role/:id','put',{params:{id:'target'},body:{role},user:{id:'actor',role:'admin'}});assert.equal(res.statusCode,403);assert.equal(h.updates.length,0);}
});
test('actual account status route denies Admin changes to an Owner account',async()=>{
  const h=load('admin',{id:'target',role:'owner',isActive:true});const res=await invoke(h.router,'/toggle-status/:id','put',{params:{id:'target'},body:{isActive:false},user:{id:'actor',role:'admin'}});assert.equal(res.statusCode,403);assert.equal(h.updates.length,0);
});
