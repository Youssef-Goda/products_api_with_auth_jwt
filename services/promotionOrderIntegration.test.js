'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {createOrderWithItems}=require('./orderCreationService');

function setup(paymentMethod='card'){
  const committed={orders:[],items:[],redemptions:[],audit:[]};
  const sequelize={
    async transaction(callback){const staged={orders:[],items:[],redemptions:[],audit:[]};const result=await callback(staged);Object.assign(committed,staged);return result;},
    async query(sql,options={}){
      if(sql.includes('promotion_redemptions'))options.transaction.redemptions.push(options.replacements);
      if(sql.includes('promotion_audit_logs'))options.transaction.audit.push(options.replacements);
      return [];
    },
  };
  const Product={findAll:async()=>[{id:'product-a',costPrice:'40.00'}]};
  const prepareOrder=async()=>({items:[{productId:'product-a',productName:'Actual DB item',productCode:'A',imageUrl:null,unitPrice:100,quantity:1,originalSubtotal:100,effectiveSubtotal:90,discountAmount:10,effectiveUnitPrice:90,promotionIds:['promotion-a'],promotionNames:['Save'],costSnapshot:40}],originalSubtotal:100,subtotal:90,discountTotal:10,tax:9,total:99,couponCode:'SAVE',promotions:[{id:'promotion-a',name:'Save'}],reservations:[{promotionId:'promotion-a',discountAmount:10}]});
  return {sequelize,Product,committed,prepareOrder,paymentMethod};
}

async function create(f,{clientItems=[]}={}){
  return createOrderWithItems({
    sequelize:f.sequelize,Product:f.Product,initialStatus:f.paymentMethod==='cod'?'pending':'pending_payment',
    items:clientItems,orderData:{user_id:'customer-a',payment_method:f.paymentMethod,subtotal:999,total:1},
    prepareOrder:f.prepareOrder,userId:'customer-a',idempotencyKey:'checkout-key',
    insertOrder:async({transaction,orderData})=>{transaction.orders.push(orderData);return{id:'order-a',...orderData};},
    insertItems:async({transaction,items})=>transaction.items.push(...items),
  });
}

test('order persists only database-priced cart values and reserves Paymob coupon in the transaction',async()=>{
  const f=setup('card');
  const result=await create(f,{clientItems:[{product_id:'fake',unit_price:0,quantity:100}]});
  assert.equal(f.committed.orders[0].total,99);
  assert.equal(f.committed.orders[0].subtotal,90);
  assert.equal(f.committed.items[0].unit_price,100);
  assert.equal(f.committed.items[0].original_subtotal,100);
  assert.equal(f.committed.items[0].subtotal,90);
  assert.equal(f.committed.items[0].unit_cost_snapshot,40);
  assert.equal(f.committed.redemptions[0].status,'reserved');
  assert.equal(result.orderRow.id,'order-a');
});

test('COD coupon is consumed with the order commit and unknown cost remains null',async()=>{
  const f=setup('cod');
  f.Product.findAll=async()=>[{id:'product-a',costPrice:null}];
  await create(f);
  assert.equal(f.committed.redemptions[0].status,'consumed');
  assert.equal(f.committed.items[0].unit_cost_snapshot,null);
});

test('item insert failure rolls back order and coupon reservation together',async()=>{
  const f=setup('card');
  await assert.rejects(createOrderWithItems({
    sequelize:f.sequelize,Product:f.Product,initialStatus:'pending_payment',items:[],orderData:{user_id:'customer-a',payment_method:'card'},prepareOrder:f.prepareOrder,userId:'customer-a',idempotencyKey:'checkout-key',
    insertOrder:async({transaction,orderData})=>{transaction.orders.push(orderData);return{id:'order-a'};},
    insertItems:async()=>{throw new Error('insert failed');},
  }),/insert failed/);
  assert.deepEqual(f.committed,{orders:[],items:[],redemptions:[],audit:[]});
});
