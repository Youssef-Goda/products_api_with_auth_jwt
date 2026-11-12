'use strict';

const { QueryTypes } = require('sequelize');
const { calculateCartProfitability, allocateDiscountCents, percentageDiscountCents, toCents, fromCents } = require('./cartProfitability');
const { classifyPromotionFinancials, promotionFinancialFingerprint } = require('./promotionApprovalPolicy');
const { calculatePromotionFinancials } = require('./promotionFinancials');

const TAX_RATE_BPS = 1000; // Existing Dealio checkout tax: 10%.
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });

function getEligibility(promotion, product, customerId) {
  const id=String(product.id), category=product.categoryId==null?null:String(product.categoryId);
  const customerAllowed=!promotion.eligible_customer_ids?.length||promotion.eligible_customer_ids.map(String).includes(String(customerId));
  const productAllowed=!promotion.eligible_product_ids?.length||promotion.eligible_product_ids.map(String).includes(id);
  const categoryAllowed=!promotion.eligible_category_ids?.length||promotion.eligible_category_ids.map(String).includes(category);
  const excluded=promotion.excluded_product_ids?.map(String).includes(id)||promotion.excluded_category_ids?.map(String).includes(category);
  return customerAllowed&&productAllowed&&categoryAllowed&&!excluded;
}

function allocationFor(promotion, lines) {
  const eligible=lines.map((line)=>promotion.appliedLineCents[line.id]||0);
  const subtotal=eligible.reduce((sum,value)=>sum+value,0);
  if(subtotal<=0) return {discount:0,shares:eligible.map(()=>0)};
  let discount=promotion.discount_type==='percentage'
    ? percentageDiscountCents(subtotal,promotion.discount_value)
    : toCents(promotion.discount_value,'Promotion discount');
  if(promotion.max_discount!=null)discount=Math.min(discount,toCents(promotion.max_discount,'Maximum discount'));
  discount=Math.min(discount,subtotal);
  return {discount,shares:allocateDiscountCents(eligible,discount)};
}

async function currentPolicy(sequelize,transaction) {
  const rows=await sequelize.query('SELECT minimum_gross_margin FROM promotion_policy WHERE id=true',{type:QueryTypes.SELECT,transaction});
  return Number(rows[0]?.minimum_gross_margin??20);
}

async function reconcileTerminalReservations(sequelize,transaction) {
  const expired=await sequelize.query(`UPDATE promotion_redemptions r SET status='expired',updated_at=now()
    FROM orders o WHERE r.order_id=o.id AND r.status='reserved' AND r.expires_at IS NOT NULL AND r.expires_at<=now()
    AND o.payment_status IN ('pending','initiated') AND (o.payment_status='pending' OR o.payment_expires_at<=now())
    RETURNING r.status,r.promotion_id,r.customer_id,r.order_id,r.discount_amount`,{type:QueryTypes.SELECT,transaction});
  const released=await sequelize.query(`UPDATE promotion_redemptions r SET status='released',updated_at=now()
    FROM orders o WHERE r.order_id=o.id AND r.status='reserved' AND (o.payment_status IN ('failed','cancelled','refunded') OR o.status IN ('cancelled','refunded'))
    RETURNING r.status,r.promotion_id,r.customer_id,r.order_id,r.discount_amount`,{type:QueryTypes.SELECT,transaction});
  for(const row of [...expired,...released])await sequelize.query(`INSERT INTO promotion_audit_logs(promotion_id,actor_id,action,details) VALUES(:promotionId,:actorId,:action,CAST(:details AS jsonb))`,{transaction,replacements:{promotionId:row.promotion_id,actorId:row.customer_id,action:row.status==='expired'?'redemption_expired':'redemption_released',details:JSON.stringify({orderId:row.order_id,discountAmount:row.discount_amount,reason:'reservation_reconciliation'})}});
}

async function calculatePromotionCheckout({sequelize,Product,userId,couponCode=null,transaction,lockRows=false,reserveOrderId=null,paymentMethod='cod'}) {
  const cartRows=await sequelize.query('SELECT product_id,quantity FROM cart_items WHERE user_id=:userId ORDER BY product_id'+(lockRows?' FOR UPDATE':''),{type:QueryTypes.SELECT,transaction,replacements:{userId}});
  if(!cartRows.length)throw error('CART_EMPTY','Your cart is empty.');
  for(const row of cartRows)if(!Number.isSafeInteger(Number(row.quantity))||Number(row.quantity)<1)throw error('INVALID_CART','Cart contains an invalid quantity.');
  const productIds=[...new Set(cartRows.map((row)=>String(row.product_id)))];
  const products=await Product.findAll({where:{id:productIds},attributes:['id','name','code','price','costPrice','categoryId','imageUrls'],order:[['id','ASC']],transaction,lock:lockRows?transaction.LOCK?.UPDATE:undefined});
  const byId=new Map(products.map((product)=>[String(product.id),product]));
  if(products.length!==productIds.length)throw error('PRODUCT_UNAVAILABLE','One or more cart products are unavailable.',409);
  const lines=cartRows.map((row,index)=>{
    const p=byId.get(String(row.product_id));
    const price=Number(p.price);
    if(!Number.isFinite(price)||price<0)throw error('INVALID_PRODUCT_PRICE','A product has an invalid price.',409);
    const unitCents=Math.round(price*100),quantity=Number(row.quantity),subtotal=unitCents*quantity;
    if(!Number.isSafeInteger(subtotal))throw error('INVALID_CART','Cart total exceeds the supported range.');
    return {id:String(p.id),product:p,quantity,index,unitCents,subtotalCents:subtotal,discountCents:0,promotionIds:[],promotionNames:[]};
  });
  const originalSubtotal=lines.reduce((sum,line)=>sum+line.subtotalCents,0);
  let offers=await sequelize.query(`SELECT p.*,c.status AS campaign_status,c.starts_at AS campaign_starts_at,c.ends_at AS campaign_ends_at,c.target_customer_ids
    FROM promotions p LEFT JOIN promotion_campaigns c ON c.id=p.campaign_id WHERE p.kind='automatic' ORDER BY p.priority DESC,p.created_at ASC`,{type:QueryTypes.SELECT,transaction});
  const normalizedCode=String(couponCode||'').trim().toUpperCase();
  let coupon=null;
  if(normalizedCode){
    const rows=await sequelize.query(`SELECT p.*,c.status AS campaign_status,c.starts_at AS campaign_starts_at,c.ends_at AS campaign_ends_at,c.target_customer_ids
      FROM promotions p LEFT JOIN promotion_campaigns c ON c.id=p.campaign_id WHERE p.kind='coupon' AND upper(btrim(p.coupon_code))=:code`,{type:QueryTypes.SELECT,transaction,replacements:{code:normalizedCode}});
    coupon=rows[0];
    if(!coupon)throw error('COUPON_INVALID','This coupon code is invalid.');
    if(['pending_approval','partially_approved','pending_owner_approval'].includes(coupon.status))throw error('PROMOTION_REQUIRES_APPROVAL','This coupon is waiting for internal approval.',409);
    if(coupon.status==='rejected'||['paused','cancelled','draft','expired'].includes(coupon.status))throw error('COUPON_INACTIVE','This coupon is not active.');
    if(coupon.starts_at&&new Date(coupon.starts_at)>new Date())throw error('COUPON_NOT_STARTED','This coupon is not active yet.');
    if(coupon.ends_at&&new Date(coupon.ends_at)<=new Date())throw error('COUPON_EXPIRED','This coupon has expired.');
    if(coupon.campaign_id&&(coupon.campaign_status!=='active'||(coupon.campaign_starts_at&&new Date(coupon.campaign_starts_at)>new Date())||(coupon.campaign_ends_at&&new Date(coupon.campaign_ends_at)<=new Date())))throw error('COUPON_INACTIVE','The campaign for this coupon is not active.');
    if(coupon.target_customer_ids?.length&&!coupon.target_customer_ids.map(String).includes(String(userId)))throw error('CUSTOMER_NOT_ELIGIBLE','This coupon campaign is not available to your account.',403);
    if(coupon.status!=='active'&&coupon.status!=='scheduled')throw error('COUPON_INACTIVE','This coupon is not active.');
  }
  offers=offers.filter((offer)=>{
    const now=Date.now();
    return ['active','scheduled'].includes(offer.status)&&(!offer.starts_at||new Date(offer.starts_at).getTime()<=now)&&(!offer.ends_at||new Date(offer.ends_at).getTime()>now)&&(!offer.campaign_id||(offer.campaign_status==='active'&&(!offer.campaign_starts_at||new Date(offer.campaign_starts_at).getTime()<=now)&&(!offer.campaign_ends_at||new Date(offer.campaign_ends_at).getTime()>now)))&&(!offer.eligible_customer_ids?.length||offer.eligible_customer_ids.map(String).includes(String(userId)))&&(!offer.target_customer_ids?.length||offer.target_customer_ids.map(String).includes(String(userId)));
  });
  const eligibleLines=(promotion)=>lines.filter((line)=>getEligibility(promotion,line.product,userId));
  const applicableAutos=offers.filter((offer)=>{
    const chosen=eligibleLines(offer),eligibleTotal=chosen.reduce((sum,line)=>sum+line.subtotalCents,0);
    return chosen.length>0&&originalSubtotal>=toCents(offer.min_order_amount||0,'Minimum order amount')&&eligibleTotal>0;
  });
  const selected=[];
  if(coupon){
    if(coupon.eligible_customer_ids?.length&&!coupon.eligible_customer_ids.map(String).includes(String(userId)))throw error('CUSTOMER_NOT_ELIGIBLE','This coupon is not available to your account.',403);
    const allowed=eligibleLines(coupon);
    if(!allowed.length)throw error('COUPON_NOT_APPLICABLE','This coupon is not applicable to the products in your cart.');
    if(originalSubtotal<toCents(coupon.min_order_amount||0,'Minimum order amount'))throw error('MINIMUM_ORDER_NOT_REACHED','Minimum order amount not reached.');
    selected.push(coupon);
    if(applicableAutos.length&&coupon.allow_stacking&&applicableAutos[0].allow_stacking)selected.push(...applicableAutos.filter((offer)=>offer.allow_stacking));
  }else if(applicableAutos.length){
    if(applicableAutos[0].allow_stacking)selected.push(...applicableAutos.filter((offer)=>offer.allow_stacking));
    else selected.push(applicableAutos[0]);
  }
  if(coupon&&applicableAutos.length&&!selected.some((offer)=>offer.kind==='automatic')){
    // A valid coupon wins over automatic offers when stacking is disabled.
  }
  if(lockRows&&selected.length){
    if(transaction)await reconcileTerminalReservations(sequelize,transaction);
    const ordered=[...selected].sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    for(const offer of ordered){
      const locked=(await sequelize.query('SELECT * FROM promotions WHERE id=:id FOR UPDATE',{type:QueryTypes.SELECT,transaction,replacements:{id:offer.id}}))[0];
      if(!locked||!['active','scheduled'].includes(locked.status))throw error('PROMOTION_UNAVAILABLE','Promotion is no longer available.',409);
      Object.assign(offer,locked);
    }
  }
  if(selected.length){
    for(const offer of selected){
      const usage=await sequelize.query(`SELECT count(*) FILTER(WHERE status='consumed' OR (status='reserved' AND (expires_at IS NULL OR expires_at>now())))::int AS total,
        count(*) FILTER(WHERE customer_id=:userId AND (status='consumed' OR (status='reserved' AND (expires_at IS NULL OR expires_at>now()))))::int AS customer_total
        FROM promotion_redemptions WHERE promotion_id=:promotionId`,{type:QueryTypes.SELECT,transaction,replacements:{userId,promotionId:offer.id}});
      if(offer.max_uses!=null&&usage[0].total>=Number(offer.max_uses))throw error('COUPON_USAGE_LIMIT_REACHED','Coupon usage limit reached.',409);
      if(offer.max_uses_per_customer!=null&&usage[0].customer_total>=Number(offer.max_uses_per_customer))throw error('CUSTOMER_USAGE_LIMIT_REACHED','You have reached this coupon usage limit.',409);
    }
  }
  for(const offer of selected){
    const eligible=eligibleLines(offer);
    if(originalSubtotal<toCents(offer.min_order_amount||0,'Minimum order amount'))throw error(offer.kind==='coupon'?'MINIMUM_ORDER_NOT_REACHED':'PROMOTION_MINIMUM_NOT_REACHED','Minimum order amount not reached.');
    const appliedLineCents=Object.fromEntries(eligible.map((line)=>[line.id,line.subtotalCents-line.discountCents]));
    const {discount,shares}=allocationFor({...offer,appliedLineCents},lines);
    if(discount<=0){
      if(offer.kind==='coupon')throw error('COUPON_NO_DISCOUNT','This coupon does not reduce the current cart total.');
      continue;
    }
    shares.forEach((amount,index)=>{if(amount>0){lines[index].discountCents+=amount;lines[index].promotionIds.push(offer.id);lines[index].promotionNames.push(offer.name);}});
    offer.appliedDiscountCents=discount;
  }
  const appliedPromotions=selected.filter((offer)=>Number(offer.appliedDiscountCents)>0);
  const currentThreshold=await currentPolicy(sequelize,transaction);
  const financialItems=lines.map((line)=>({productId:line.id,quantity:line.quantity,unitPrice:fromCents(line.unitCents),productDiscount:fromCents(line.discountCents),unit_cost_snapshot:line.product.costPrice==null?null:Number(line.product.costPrice)}));
  const profitability=await calculateCartProfitability({items:financialItems,costBasis:'orderSnapshot'});
  const totalRevenueCents=lines.reduce((sum,line)=>sum+line.subtotalCents-line.discountCents,0);
  const totalCostCents=profitability.items.every((item)=>item.unitCost!=null)?profitability.items.reduce((sum,item)=>sum+item.unitCostCents*item.quantity,0):null;
  const totalProfitCents=totalCostCents==null?null:totalRevenueCents-totalCostCents;
  const overallMargin=totalCostCents==null||totalRevenueCents===0?null:totalProfitCents/totalRevenueCents*100;
  const itemLosses=profitability.items.filter((item)=>item.isBelowCost===true);
  if(appliedPromotions.length){
    if(totalCostCents==null)throw error('PROFITABILITY_UNVERIFIED','Promotion cannot be applied because product cost data is incomplete.',409);
    const approvalsByPromotion=new Map();
    for(const offer of appliedPromotions){
      if(!['active','scheduled'].includes(offer.status)||offer.ends_at&&new Date(offer.ends_at)<=new Date())throw error('PROMOTION_UNAVAILABLE','Promotion is no longer available.',409);
      if(offer.settings_version==null)throw error('PROMOTION_REQUIRES_APPROVAL','Promotion approval version is unavailable.',409);
      const catalog=await Product.findAll({attributes:['id','price','costPrice','categoryId'],transaction});
      const currentFinancial=await calculatePromotionFinancials({promotion:offer,products:catalog,threshold:currentThreshold});
      const risk=classifyPromotionFinancials(currentFinancial,currentThreshold);
      const fingerprint=promotionFinancialFingerprint(offer,catalog,currentThreshold);
      if(risk==='unverifiable')throw error('PROFITABILITY_UNVERIFIED','Promotion profitability cannot be verified with current product costs.',409);
      const approvals=await sequelize.query('SELECT reviewer_id,reviewer_role,decision,acknowledged_loss,reason,financial_snapshot FROM promotion_approvals WHERE promotion_id=:id AND settings_version=:version',{type:QueryTypes.SELECT,transaction,replacements:{id:offer.id,version:offer.settings_version}});
      const matching=approvals.filter(a=>a.decision==='approved'&&a.financial_snapshot?.financialFingerprint===fingerprint);
      approvalsByPromotion.set(String(offer.id),matching);
      const lossRequired=itemLosses.length>0||risk==='owner_loss'||overallMargin<0;
      const lowMargin=risk==='manager_and_owner'||(overallMargin!=null&&overallMargin<currentThreshold);
      if(lossRequired){
        const ownerApproval=matching.find((a)=>a.reviewer_role==='owner'&&a.acknowledged_loss===true&&String(a.reason||'').trim());
        if(!ownerApproval)throw error('PROMOTION_REQUIRES_APPROVAL','Promotion requires explicit Owner approval for the expected product loss.',409);
        const cartLoss= itemLosses.reduce((sum,item)=>sum+Math.max(0,-Number(item.grossProfit||0)),0);
        const approvedLoss=Number(ownerApproval.financial_snapshot?.expectedLoss||0);
        if(cartLoss>approvedLoss+0.01)throw error('PROMOTION_REQUIRES_APPROVAL','Current cart loss exceeds the Owner-approved financial exposure.',409);
      }else if(lowMargin){
        const ownerApproval=matching.find((a)=>a.reviewer_role==='owner');
        const managerApproval=matching.find((a)=>a.reviewer_role==='manager');
        if(!ownerApproval||!managerApproval||String(ownerApproval.reviewer_id)===String(managerApproval.reviewer_id))throw error('PROMOTION_REQUIRES_APPROVAL','Promotion requires approval from both a Manager and the Owner.',409);
      }
    }
  }
  const discountCents=lines.reduce((sum,line)=>sum+line.discountCents,0);
  const taxCents=Number((BigInt(totalRevenueCents)*BigInt(TAX_RATE_BPS)+5000n)/10000n);
  const totalCents=totalRevenueCents+taxCents;
  if(!Number.isSafeInteger(totalCents))throw error('INVALID_CART','Cart total exceeds the supported range.');
  const lineResults=lines.map((line)=>({
    productId:line.id,productName:line.product.name,productCode:line.product.code||null,
    imageUrl:Array.isArray(line.product.imageUrls)?line.product.imageUrls[0]||null:null,
    quantity:line.quantity,unitPrice:fromCents(line.unitCents),originalSubtotal:fromCents(line.subtotalCents),
    discountAmount:fromCents(line.discountCents),effectiveSubtotal:fromCents(line.subtotalCents-line.discountCents),
    effectiveUnitPrice:(line.subtotalCents-line.discountCents)/100/line.quantity,
    promotionIds:[...new Set(line.promotionIds)],promotionNames:[...new Set(line.promotionNames)],
    costSnapshot:line.product.costPrice==null?null:Number(line.product.costPrice),
  }));
  return {items:lineResults,originalSubtotal:fromCents(originalSubtotal),subtotal:fromCents(totalRevenueCents),discountTotal:fromCents(discountCents),tax:fromCents(taxCents),total:fromCents(totalCents),currency:'EGP',couponCode:coupon&&appliedPromotions.some((p)=>String(p.id)===String(coupon.id))?normalizedCode:null,promotions:appliedPromotions.map((p)=>({id:p.id,name:p.name,kind:p.kind,discountAmount:fromCents(p.appliedDiscountCents||0)})),financial:{grossProfit:totalProfitCents==null?null:fromCents(totalProfitCents),grossMargin:overallMargin,itemLosses,verified:totalCostCents!=null},reservations:appliedPromotions.map((p)=>({promotionId:p.id,discountAmount:fromCents(p.appliedDiscountCents||0)})),threshold:currentThreshold};
}

module.exports={calculatePromotionCheckout,error,TAX_RATE_BPS};
