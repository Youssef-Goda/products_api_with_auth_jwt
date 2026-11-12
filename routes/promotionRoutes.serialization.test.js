'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const Module=require('node:module');
function load(){
  const real=Module._load;Module._load=function(request,parent,isMain){
    if(request==='../config/database'&&parent?.filename?.endsWith('/routes/promotionRoutes.js'))return {query:async()=>[{id:'p1',status:'pending_approval',margin_snapshot:3,profit_snapshot:-4,expected_loss:4,loss_making:true,financial:{grossMargin:3},approvals:[{reviewer_role:'owner',financial_snapshot:{financialFingerprint:'secret'}}]}],transaction:async(fn)=>fn({})};
    if(request==='../models/Product'&&parent?.filename?.endsWith('/routes/promotionRoutes.js'))return {};
    if(request==='../models/User'&&parent?.filename?.endsWith('/routes/promotionRoutes.js'))return {findByPk:async()=>({id:'admin1',role:'admin',isActive:true}),findAll:async()=>[]};
    if(request==='../middlewares/authMiddleware'&&parent?.filename?.endsWith('/routes/promotionRoutes.js'))return {authenticateToken:(req,res,next)=>next()};
    if(request==='../utils/fcmService'&&parent?.filename?.endsWith('/routes/promotionRoutes.js'))return {sendNotification:async()=>{}};
    return real.call(this,request,parent,isMain);
  };delete require.cache[require.resolve('./promotionRoutes')];const router=require('./promotionRoutes');Module._load=real;return router;
}
test('actual Admin promotions list response removes nested financial approval details',async()=>{
  const router=load();const layer=router.stack.find(x=>x.route?.path==='/'&&x.route.methods.get);const handlers=layer.route.stack.map(x=>x.handle);const res={statusCode:200,body:null,status(n){this.statusCode=n;return this;},json(b){this.body=b;return this;}};const req={user:{id:'admin1',role:'admin'}};let i=0;const next=async(e)=>{if(e)throw e;const fn=handlers[i++];if(fn)await fn(req,res,next);};await next();
  assert.equal(res.statusCode,200);const row=res.body.data[0];
  for(const key of ['margin_snapshot','profit_snapshot','expected_loss','loss_making','financial','approvals'])assert.equal(key in row,false,key);
});
