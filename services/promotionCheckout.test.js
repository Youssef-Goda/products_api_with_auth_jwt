'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {calculatePromotionCheckout}=require('./promotionCheckout');
const {promotionFinancialFingerprint}=require('./promotionApprovalPolicy');

const baseProduct={id:'product-a',name:'A',code:'A',price:100,costPrice:'40.00',categoryId:'category-a',imageUrls:[]};
function fixture({cart=[{product_id:'product-a',quantity:1}],coupon=null,automatic=[],usage={total:0,customer_total:0},approvals=[]}={}){
  const queries=[];
  const sequelize={query:async(sql,options={})=>{
    queries.push(sql);
    if(sql.includes('SELECT product_id,quantity FROM cart_items'))return cart;
    if(sql.includes("p.kind='automatic'"))return automatic;
    if(sql.includes("p.kind='coupon'"))return coupon?[coupon]:[];
    if(sql.includes('SELECT minimum_gross_margin'))return [{minimum_gross_margin:20}];
    if(sql.includes('count(*) FILTER(WHERE status'))return [usage];
    if(sql.includes('FROM promotion_approvals'))return approvals;
    throw new Error(`Unexpected SQL in test: ${sql}`);
  }};
  const Product={findAll:async({where}={})=>[baseProduct].filter(p=>!where?.id||where.id.includes(p.id))};
  return {sequelize,Product,queries,run:(args={})=>calculatePromotionCheckout({sequelize,Product,userId:'customer-a',transaction:{},...args})};
}
const coupon=(changes={})=>({id:'promo-a',name:'Save',kind:'coupon',status:'active',discount_type:'percentage',discount_value:10,eligible_product_ids:[],eligible_category_ids:[],excluded_product_ids:[],excluded_category_ids:[],eligible_customer_ids:[],allow_stacking:false,min_order_amount:'0.00',max_discount:null,max_uses:null,max_uses_per_customer:null,margin_snapshot:50,loss_making:false,settings_version:1,starts_at:null,ends_at:null,...changes});

test('percentage coupon returns totals from backend prices and applies tax after discount',async()=>{
  const f=fixture({coupon:coupon()});
  const result=await f.run({couponCode:' save '});
  assert.equal(result.originalSubtotal,100);
  assert.equal(result.discountTotal,10);
  assert.equal(result.subtotal,90);
  assert.equal(result.tax,9);
  assert.equal(result.total,99);
  assert.equal(result.financial.grossProfit,50);
  assert.equal(result.financial.verified,true);
  assert.equal(f.queries.some(sql=>sql.startsWith('INSERT')),false,'preview must not reserve usage');
});

test('fixed discount is capped to eligible item totals and max discount',async()=>{
  const f=fixture({coupon:coupon({discount_type:'fixed',discount_value:80,max_discount:'25.00'})});
  const result=await f.run({couponCode:'SAVE'});
  assert.equal(result.discountTotal,25);
});

test('category restrictions reject a coupon with no eligible products',async()=>{
  const f=fixture({coupon:coupon({eligible_category_ids:['different-category']})});
  await assert.rejects(f.run({couponCode:'SAVE'}),error=>error.code==='COUPON_NOT_APPLICABLE');
});

test('unknown unit cost blocks a promotion rather than being treated as zero',async()=>{
  const f=fixture({coupon:coupon()});
  f.Product.findAll=async()=>[{...baseProduct,costPrice:null}];
  await assert.rejects(f.run({couponCode:'SAVE'}),error=>error.code==='PROFITABILITY_UNVERIFIED');
});

test('usage limits block coupon preview without reserving',async()=>{
  const f=fixture({coupon:coupon({max_uses:2}),usage:{total:2,customer_total:2}});
  await assert.rejects(f.run({couponCode:'SAVE'}),error=>error.code==='COUPON_USAGE_LIMIT_REACHED');
});

test('higher priority automatic promotion wins when stacking is disabled',async()=>{
  const automatic=[
    {id:'auto-high',name:'High',kind:'automatic',status:'active',discount_type:'fixed',discount_value:10,priority:10,allow_stacking:false,eligible_product_ids:[],eligible_category_ids:[],excluded_product_ids:[],excluded_category_ids:[],eligible_customer_ids:[],min_order_amount:'0.00',max_discount:null,settings_version:1,margin_snapshot:50,loss_making:false},
    {id:'auto-low',name:'Low',kind:'automatic',status:'active',discount_type:'fixed',discount_value:5,priority:1,allow_stacking:false,eligible_product_ids:[],eligible_category_ids:[],excluded_product_ids:[],excluded_category_ids:[],eligible_customer_ids:[],min_order_amount:'0.00',max_discount:null,settings_version:1,margin_snapshot:50,loss_making:false},
  ];
  const f=fixture({automatic});
  const result=await f.run();
  assert.equal(result.discountTotal,10);
  assert.deepEqual(result.promotions.map(p=>p.id),['auto-high']);
});

test('positive cart margin below threshold requires distinct Manager and Owner approvals',async()=>{
  const offer=coupon({discount_value:10});
  const fingerprint=promotionFinancialFingerprint(offer,[{...baseProduct,costPrice:'75.00'}],20);
  const f=fixture({coupon:offer,approvals:[
    {reviewer_id:'owner-1',reviewer_role:'owner',decision:'approved',financial_snapshot:{financialFingerprint:fingerprint}},
    {reviewer_id:'manager-1',reviewer_role:'manager',decision:'approved',financial_snapshot:{financialFingerprint:fingerprint}},
  ]});
  f.Product.findAll=async()=>[{...baseProduct,costPrice:'75.00'}];
  const result=await f.run({couponCode:'SAVE'});
  assert.equal(result.financial.grossProfit,15);
  assert.ok(result.financial.grossMargin<20);
  f.sequelize.query=async(sql,options={})=>{
    if(sql.includes('FROM promotion_approvals'))return [{reviewer_id:'same',reviewer_role:'owner',decision:'approved',financial_snapshot:{financialFingerprint:fingerprint}},{reviewer_id:'same',reviewer_role:'manager',decision:'approved',financial_snapshot:{financialFingerprint:fingerprint}}];
    if(sql.includes('SELECT product_id,quantity FROM cart_items'))return [{product_id:'product-a',quantity:1}];
    if(sql.includes("p.kind='automatic'"))return [];
    if(sql.includes("p.kind='coupon'"))return [coupon({discount_value:10})];
    if(sql.includes('SELECT minimum_gross_margin'))return [{minimum_gross_margin:20}];
    if(sql.includes('count(*) FILTER(WHERE status'))return [{total:0,customer_total:0}];
    return [];
  };
  await assert.rejects(f.run({couponCode:'SAVE'}),e=>e.code==='PROMOTION_REQUIRES_APPROVAL');
});

test('a single loss-making eligible product requires Owner loss acknowledgement',async()=>{
  const offer=coupon({discount_value:70});
  const fingerprint=promotionFinancialFingerprint(offer,[baseProduct],20);
  const approvals=[{reviewer_id:'owner',reviewer_role:'owner',decision:'approved',acknowledged_loss:true,reason:'approved exception',financial_snapshot:{financialFingerprint:fingerprint,expectedLoss:10}}];
  const f=fixture({coupon:offer,approvals});
  f.Product.findAll=async()=>[{...baseProduct,costPrice:'40.00'}];
  const result=await f.run({couponCode:'SAVE'});
  assert.equal(result.financial.grossProfit,-10);
  assert.equal(result.financial.itemLosses.length,1);
  f.sequelize.query=async(sql)=>sql.includes('FROM promotion_approvals')?[{...approvals[0],acknowledged_loss:false}]:sql.includes("p.kind='coupon'")?[offer]:sql.includes('SELECT product_id,quantity FROM cart_items')?[{product_id:'product-a',quantity:1}]:sql.includes("p.kind='automatic'")?[]:sql.includes('SELECT minimum_gross_margin')?[{minimum_gross_margin:20}]:sql.includes('count(*) FILTER(WHERE status')?[{total:0,customer_total:0}]:[];
  await assert.rejects(f.run({couponCode:'SAVE'}),e=>e.code==='PROMOTION_REQUIRES_APPROVAL');
});
