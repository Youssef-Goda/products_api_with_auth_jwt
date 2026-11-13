'use strict';

const express = require('express');
const router = express.Router();
const { QueryTypes } = require('sequelize');
const sequelize = require('../config/database');
const Product = require('../models/Product');
const User = require('../models/User');
const { sendNotification } = require('../utils/fcmService');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { calculatePromotionFinancials } = require('../services/promotionFinancials');
const { calculatePromotionCheckout } = require('../services/promotionCheckout');
const { classifyPromotionFinancials, promotionFinancialFingerprint } = require('../services/promotionApprovalPolicy');
const { promotionDto: sanitizePromotionDto } = require('../services/promotionResponsePolicy');
const { generateCouponCode, normalizeCouponPrefix } = require('../services/couponCodeGenerator');

const role = (req) => String(req.user?.role || '').toLowerCase();
const canManage = (req) => ['owner', 'manager', 'admin'].includes(role(req));
const owner = (req) => role(req) === 'owner';
const isManager = (req) => role(req) === 'manager';
const fail = (res, status, message) => res.status(status).json({ success: false, message });
const promotionDto = (value, req) => sanitizePromotionDto(value,role(req));
const audit = async (transaction, promotionId, actorId, action, details = {}) => sequelize.query(
  'INSERT INTO public.promotion_audit_logs(promotion_id,actor_id,action,details) VALUES(:promotionId,:actorId,:action,CAST(:details AS jsonb))',
  { replacements: { promotionId: promotionId || null, actorId, action, details: JSON.stringify(details) }, transaction },
);
const getPolicy = async (transaction) => {
  const rows = await sequelize.query('SELECT minimum_gross_margin FROM public.promotion_policy WHERE id=true', { type: QueryTypes.SELECT, transaction });
  return Number(rows[0]?.minimum_gross_margin ?? 20);
};
async function notifyRoles(roles, title, body, data = {}) {
  try {
    const users = await User.findAll({ where: { role: roles }, attributes: ['fcmToken'] });
    await Promise.all(users.filter((user) => user.fcmToken).map((user) => sendNotification(user.fcmToken, title, body, { type: 'promotion', ...data })));
  } catch (error) { console.warn('[Promotions] Notification delivery failed:', error.message); }
}

router.use(authenticateToken);
router.use(async (req,res,next)=>{
  try {
    const actor=await User.findByPk(req.user.id,{attributes:['id','role','isActive']});
    if(!actor||actor.isActive===false)return fail(res,403,'Active account required.');
    req.user.role=String(actor.role||'').toLowerCase();
    next();
  } catch(error) { res.status(500).json({success:false,message:'Could not verify promotion permissions.'}); }
});

async function sendCheckoutPreview(req,res) {
  try{
    const pricing=await sequelize.transaction((transaction)=>calculatePromotionCheckout({sequelize,Product,userId:req.user.id,couponCode:req.body?.couponCode||req.body?.code||null,transaction}));
    res.json({success:true,data:{items:pricing.items.map(({productId,productName,productCode,imageUrl,quantity,unitPrice,originalSubtotal,discountAmount,effectiveSubtotal,effectiveUnitPrice,promotionNames})=>({productId,productName,productCode,imageUrl,quantity,unitPrice,originalSubtotal,discountAmount,effectiveSubtotal,effectiveUnitPrice,promotionNames})),originalSubtotal:pricing.originalSubtotal,subtotal:pricing.subtotal,discountTotal:pricing.discountTotal,tax:pricing.tax,total:pricing.total,currency:pricing.currency,couponCode:pricing.couponCode,promotions:pricing.promotions}});
  }catch(e){res.status(e.status||400).json({success:false,code:e.code||'CHECKOUT_PREVIEW_FAILED',message:e.message});}
}
router.post('/checkout-preview',sendCheckoutPreview);

// Admin console list and performance summary. Financial fields are returned only to trusted staff.
router.get('/', async (req, res) => {
  if (!canManage(req)) return fail(res, 403, 'Promotion access denied.');
  try {
    const rows = await sequelize.query(`SELECT p.*, (SELECT count(*) FROM promotion_redemptions r WHERE r.promotion_id=p.id AND r.status='consumed') AS redemption_count,
      (SELECT coalesce(sum(discount_amount),0) FROM promotion_redemptions r WHERE r.promotion_id=p.id AND r.status='consumed') AS discount_total,
      coalesce((SELECT json_agg(a ORDER BY a.settings_version,a.created_at) FROM promotion_approvals a WHERE a.promotion_id=p.id),'[]'::json) AS approvals
      FROM promotions p ORDER BY p.created_at DESC`, { type: QueryTypes.SELECT });
    res.json({ success: true, data: rows.map((row) => promotionDto(row,req)) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post('/', async (req, res) => {
  if (!canManage(req)) return fail(res, 403, 'Only Owner, Manager, or Admin can create promotions.');
  const b = req.body || {};
  const kind = b.kind || (b.couponCode ? 'coupon' : 'automatic');
  const autoGenerateCode=b.autoGenerateCode===true;
  let code = b.couponCode == null || String(b.couponCode).trim() === '' ? null : String(b.couponCode).trim().toUpperCase();
  if (!String(b.name || '').trim() || !['coupon','automatic'].includes(kind) || !['percentage','fixed'].includes(b.discountType) || !Number.isFinite(Number(b.discountValue)) || Number(b.discountValue) <= 0) return fail(res, 400, 'Name, promotion type, discount type, and positive discount value are required.');
  if(autoGenerateCode&&kind!=='coupon')return fail(res,400,'Automatic code generation is available for coupons only.');
  let couponPrefix='';
  if(autoGenerateCode){try{couponPrefix=normalizeCouponPrefix(b.couponPrefix||'');}catch(e){return fail(res,400,e.message);}}
  if (kind === 'coupon' && !autoGenerateCode && (!code || !/^[A-Z0-9_-]{3,40}$/.test(code))) return fail(res, 400, 'Coupon code must contain 3–40 letters, digits, underscores, or hyphens.');
  if (b.discountType === 'percentage' && Number(b.discountValue) > 100) return fail(res, 400, 'Percentage discount cannot exceed 100%.');
  const listFields=['eligibleProductIds','eligibleCategoryIds','excludedProductIds','excludedCategoryIds','eligibleCustomerIds'];
  if(listFields.some((field)=>b[field]!=null&&(!Array.isArray(b[field])||b[field].some((id)=>typeof id!=='string'||!id.trim()))))return fail(res,400,'Product, category, and customer eligibility fields must be arrays of non-empty IDs.');
  const start=b.startsAt?new Date(b.startsAt):null,end=b.endsAt?new Date(b.endsAt):null;
  if((start&&!Number.isFinite(start.getTime()))||(end&&!Number.isFinite(end.getTime()))||(start&&end&&start>=end))return fail(res,400,'Promotion dates are invalid. Expiration must follow the start date.');
  if(!Number.isFinite(Number(b.minOrderAmount||0))||Number(b.minOrderAmount||0)<0|| (b.maxDiscount!=null&&(!Number.isFinite(Number(b.maxDiscount))||Number(b.maxDiscount)<=0)))return fail(res,400,'Minimum order and maximum discount values are invalid.');
  if([b.maxUses,b.maxUsesPerCustomer].some(v=>v!=null&&(!Number.isSafeInteger(Number(v))||Number(v)<1)))return fail(res,400,'Usage limits must be positive whole numbers.');
  if(b.priority!=null&&!Number.isSafeInteger(Number(b.priority)))return fail(res,400,'Promotion priority must be a whole number.');
  try {
    const ids = [...new Set([...(b.eligibleProductIds || []), ...(b.excludedProductIds || [])].map(String))];
    const products = (b.eligibleProductIds||[]).length && !(b.eligibleCategoryIds||[]).length
      ? await Product.findAll({ where: { id: ids }, attributes: ['id','price','costPrice','categoryId'] })
      : await Product.findAll({ attributes: ['id','price','costPrice','categoryId'] });
    if (ids.some((id) => !products.some((p) => String(p.id) === id))) return fail(res, 400, 'One or more products do not exist.');
    const threshold = await getPolicy();
    const p = {
      discount_type: b.discountType, discount_value: Number(b.discountValue), max_discount: b.maxDiscount ?? null,
      eligible_product_ids: b.eligibleProductIds || [], eligible_category_ids: b.eligibleCategoryIds || [],
      excluded_product_ids: b.excludedProductIds || [], excluded_category_ids: b.excludedCategoryIds || [],
    };
    const financial = await calculatePromotionFinancials({ promotion: p, products, threshold });
    // Unknown cost blocks automatic activation: it remains in review until costs can be verified.
    financial.financialFingerprint = promotionFinancialFingerprint(p,products,threshold);
    const risk = classifyPromotionFinancials(financial,threshold);
    let status = 'draft';
    if (risk === 'unverifiable' || risk === 'manager_and_owner') status = 'pending_approval';
    else if (risk === 'owner_loss') status = 'pending_owner_approval';
    else status = b.startsAt && new Date(b.startsAt) > new Date() ? 'scheduled' : (b.activate === true ? 'active' : 'draft');
    let result;
    let generationAttempt=0;
    while(true){
      generationAttempt++;
      if(autoGenerateCode)code=generateCouponCode({prefix:couponPrefix});
      try{result=await sequelize.transaction(async (transaction) => {
      const rows = await sequelize.query(`INSERT INTO public.promotions(name,description,kind,status,discount_type,discount_value,coupon_code,starts_at,ends_at,min_order_amount,max_discount,max_uses,max_uses_per_customer,eligible_product_ids,eligible_category_ids,excluded_product_ids,excluded_category_ids,eligible_customer_ids,campaign_id,priority,allow_stacking,margin_snapshot,profit_snapshot,expected_loss,loss_making,creator_id)
        VALUES($name,$description,$kind,$status,$discountType,$discountValue,$code,$startsAt,$endsAt,$minOrderAmount,$maxDiscount,$maxUses,$maxUsesPerCustomer,CAST($productIds AS uuid[]),CAST($categoryIds AS uuid[]),CAST($excludedIds AS uuid[]),CAST($excludedCategoryIds AS uuid[]),CAST($customerIds AS uuid[]),$campaignId,$priority,$allowStacking,$margin,$profit,$expectedLoss,$lossMaking,$creatorId) RETURNING *`, {
        type: QueryTypes.INSERT, transaction, bind: {
          name: String(b.name).trim(), description: b.description || null, kind, status, discountType: b.discountType, discountValue: Number(b.discountValue), code,
          startsAt: start, endsAt: end, minOrderAmount: Number(b.minOrderAmount || 0), maxDiscount: b.maxDiscount ?? null,
          maxUses: b.maxUses ?? null, maxUsesPerCustomer: b.maxUsesPerCustomer ?? null, productIds: b.eligibleProductIds || [], categoryIds: b.eligibleCategoryIds || [], excludedIds: b.excludedProductIds || [], excludedCategoryIds: b.excludedCategoryIds || [], customerIds: b.eligibleCustomerIds || [], campaignId: b.campaignId || null,
          priority: Number(b.priority || 0), allowStacking:b.allowStacking===true, margin: financial.grossMargin, profit: financial.grossProfit, expectedLoss: financial.expectedLoss || 0, lossMaking: financial.lossMaking, creatorId: req.user.id,
        },
      });
      const row = Array.isArray(rows[0]) ? rows[0][0] : rows[0];
      await audit(transaction, row.id, req.user.id, 'created', { status, financial });
      return row;
      });break;}catch(error){
        const collision=error.name==='SequelizeUniqueConstraintError'||/unique|duplicate key/i.test(error.message||'');
        if(autoGenerateCode&&collision&&generationAttempt<8)continue;
        throw error;
      }
    }
    res.status(201).json({ success: true, data: promotionDto({ ...result, financial, approvalsRequired: status === 'pending_owner_approval' ? ['owner'] : status === 'pending_approval' ? ['manager','owner'] : [] },req) });
    if (status === 'pending_owner_approval') await notifyRoles(['owner'], 'Promotion needs Owner approval', `${b.name} needs review. Expected gross loss: ${financial.expectedLoss}.`, { promotionId: result.id });
    else if (status === 'pending_approval') await notifyRoles(['owner','manager'], 'Promotion needs approval', `${b.name} needs financial review.`, { promotionId: result.id });
  } catch (e) {
    const duplicate = e.name === 'SequelizeUniqueConstraintError' || /unique/i.test(e.message);
    res.status(duplicate ? 409 : 400).json({ success: false, message: duplicate ? 'Coupon code already exists.' : e.message });
  }
});

router.post('/:id/decision', async (req, res) => {
  if (!['owner','manager'].includes(role(req))) return fail(res, 403, 'Only Owner or Manager can review financial promotions.');
  const { decision, reason, acknowledgeLoss } = req.body || {};
  if (!['approved','rejected'].includes(decision)) return fail(res, 400, 'Decision must be approved or rejected.');
  if (decision === 'rejected' && !String(reason || '').trim()) return fail(res, 400, 'A rejection reason is required.');
  try {
    const output = await sequelize.transaction(async (transaction) => {
      const rows = await sequelize.query('SELECT * FROM promotions WHERE id=:id FOR UPDATE', { type: QueryTypes.SELECT, transaction, replacements: { id: req.params.id } });
      const p = rows[0];
      if (!p) throw Object.assign(new Error('Promotion not found.'), { status: 404 });
      if (p.creator_id === req.user.id) throw Object.assign(new Error('The creator cannot approve their own restricted promotion.'), { status: 403 });
      if (!['pending_approval','partially_approved','pending_owner_approval'].includes(p.status)) throw Object.assign(new Error('This promotion is not awaiting approval.'), { status: 409 });
      if (p.status === 'pending_owner_approval' && !owner(req)) throw Object.assign(new Error('Only the Owner can decide a loss-making promotion.'), { status: 403 });
      if (isManager(req) && p.status === 'pending_owner_approval') throw Object.assign(new Error('Manager approval cannot approve a loss-making promotion.'), { status: 403 });
      const products=await Product.findAll({attributes:['id','price','costPrice','categoryId'],transaction});
      const threshold=await getPolicy(transaction);
      const currentFinancial=await calculatePromotionFinancials({promotion:p,products,threshold});
      const risk=classifyPromotionFinancials(currentFinancial,threshold);
      currentFinancial.financialFingerprint=promotionFinancialFingerprint(p,products,threshold);
      if(decision==='approved'&&risk==='unverifiable')throw Object.assign(new Error('Profitability cannot be verified with current product costs.'),{status:409});
      const approvals = await sequelize.query('SELECT * FROM promotion_approvals WHERE promotion_id=:id AND settings_version=:version', { type: QueryTypes.SELECT, transaction, replacements: { id: p.id, version: p.settings_version } });
      const staleApproval=approvals.some(a=>a.decision==='approved'&&a.financial_snapshot?.financialFingerprint!==currentFinancial.financialFingerprint);
      if(staleApproval){
        const nextStatus=risk==='owner_loss'?'pending_owner_approval':risk==='unverifiable'||risk==='manager_and_owner'?'pending_approval':'draft';
        await sequelize.query('UPDATE promotions SET settings_version=settings_version+1,status=:status,margin_snapshot=:margin,profit_snapshot=:profit,expected_loss=:loss,loss_making=:lossMaking,updated_at=now() WHERE id=:id',{transaction,replacements:{id:p.id,status:nextStatus,margin:currentFinancial.grossMargin,profit:currentFinancial.grossProfit,loss:currentFinancial.expectedLoss||0,lossMaking:currentFinancial.lossMaking}});
        await audit(transaction,p.id,req.user.id,'financial_inputs_changed',{previousVersion:p.settings_version,newStatus:nextStatus,financial:currentFinancial});
        return {id:p.id,status:nextStatus,approvalInvalidated:true};
      }
      if (approvals.some((a) => a.reviewer_id === req.user.id)) throw Object.assign(new Error('You already reviewed this promotion.'), { status: 409 });
      if (approvals.some((a) => a.reviewer_role === role(req))) throw Object.assign(new Error('A distinct Owner and Manager account are required.'), { status: 409 });
      if (decision === 'approved' && risk==='owner_loss' && (!owner(req) || acknowledgeLoss !== true || !String(reason || '').trim())) throw Object.assign(new Error('Loss approval requires Owner, a reason, and explicit loss acknowledgement.'), { status: 403 });
      const financial = { ...currentFinancial, settingsVersion: p.settings_version };
      await sequelize.query(`INSERT INTO promotion_approvals(promotion_id,settings_version,reviewer_id,reviewer_role,decision,reason,acknowledged_loss,financial_snapshot)
        VALUES(:id,:version,:reviewer,:role,:decision,:reason,:ack,CAST(:financial AS jsonb))`, { transaction, replacements: { id:p.id,version:p.settings_version,reviewer:req.user.id,role:role(req),decision,reason:reason || null,ack:acknowledgeLoss === true,financial:JSON.stringify(financial) } });
      let status;
      if (decision === 'rejected') status = 'rejected';
      else if (risk==='owner_loss' || risk==='normal') status = 'scheduled';
      else {
        const ownerApproved = owner(req) || approvals.some((a) => a.reviewer_role === 'owner' && a.decision === 'approved');
        const managerApproved = isManager(req) || approvals.some((a) => a.reviewer_role === 'manager' && a.decision === 'approved');
        status = ownerApproved && managerApproved ? 'scheduled' : 'partially_approved';
      }
      await sequelize.query('UPDATE promotions SET status=:status, updated_at=now() WHERE id=:id', { transaction, replacements: { status, id:p.id } });
      await audit(transaction, p.id, req.user.id, `decision_${decision}`, { reason: reason || null, financial, status });
      return { id:p.id,status,financial };
    });
    if(output.approvalInvalidated)return res.status(409).json({success:false,code:'APPROVAL_FINANCIALS_CHANGED',message:'Affected product prices or costs changed. Previous approvals were invalidated; review the updated request again.'});
    res.json({ success:true,data:output });
    await notifyRoles(['owner','manager'], 'Promotion review updated', `A reviewer recorded a ${decision} decision.`, { promotionId: output.id });
  } catch(e) { res.status(e.status || 400).json({ success:false,message:e.message }); }
});

router.patch('/:id', async (req,res) => {
  if (!canManage(req)) return fail(res,403,'Promotion access denied.');
  const b=req.body||{};
  try {
    const output=await sequelize.transaction(async(transaction)=>{
      const current=(await sequelize.query('SELECT * FROM promotions WHERE id=:id FOR UPDATE',{type:QueryTypes.SELECT,transaction,replacements:{id:req.params.id}}))[0];
      if(!current)throw Object.assign(new Error('Promotion not found.'),{status:404});
      const next={
        ...current,
        name:b.name===undefined?current.name:String(b.name).trim(),
        description:b.description===undefined?current.description:b.description,
        discount_type:b.discountType||current.discount_type,
        discount_value:b.discountValue===undefined?Number(current.discount_value):Number(b.discountValue),
        max_discount:b.maxDiscount===undefined?current.max_discount:b.maxDiscount,
        starts_at:b.startsAt===undefined?current.starts_at:(b.startsAt?new Date(b.startsAt):null),
        ends_at:b.endsAt===undefined?current.ends_at:(b.endsAt?new Date(b.endsAt):null),
        min_order_amount:b.minOrderAmount===undefined?Number(current.min_order_amount):Number(b.minOrderAmount),
        max_uses:b.maxUses===undefined?current.max_uses:(b.maxUses===''||b.maxUses==null?null:Number(b.maxUses)),
        max_uses_per_customer:b.maxUsesPerCustomer===undefined?current.max_uses_per_customer:(b.maxUsesPerCustomer===''||b.maxUsesPerCustomer==null?null:Number(b.maxUsesPerCustomer)),
        eligible_product_ids:b.eligibleProductIds===undefined?current.eligible_product_ids:b.eligibleProductIds,
        eligible_category_ids:b.eligibleCategoryIds===undefined?current.eligible_category_ids:b.eligibleCategoryIds,
        excluded_product_ids:b.excludedProductIds===undefined?current.excluded_product_ids:b.excludedProductIds,
        excluded_category_ids:b.excludedCategoryIds===undefined?current.excluded_category_ids:b.excludedCategoryIds,
        eligible_customer_ids:b.eligibleCustomerIds===undefined?current.eligible_customer_ids:b.eligibleCustomerIds,
        campaign_id:b.campaignId===undefined?current.campaign_id:(b.campaignId||null),
        allow_stacking:b.allowStacking===undefined?current.allow_stacking:b.allowStacking===true,
        priority:b.priority===undefined?current.priority:Number(b.priority),
      };
      if(!['percentage','fixed'].includes(next.discount_type)||!Number.isFinite(next.discount_value)||next.discount_value<=0||(next.discount_type==='percentage'&&next.discount_value>100))throw new Error('Invalid promotion discount settings.');
      if(!Number.isSafeInteger(next.priority)||typeof next.allow_stacking!=='boolean')throw new Error('Invalid priority or stacking setting.');
      const dateValue=(value)=>value==null||Number.isFinite(new Date(value).getTime());
      if(!dateValue(next.starts_at)||!dateValue(next.ends_at)||(next.starts_at&&next.ends_at&&new Date(next.starts_at)>=new Date(next.ends_at)))throw new Error('Promotion dates are invalid. Expiration must follow the start date.');
      if(!Number.isFinite(next.min_order_amount)||next.min_order_amount<0||[next.max_uses,next.max_uses_per_customer].some(value=>value!=null&&(!Number.isSafeInteger(value)||value<1)))throw new Error('Minimum amount or usage limits are invalid.');
      for(const field of ['eligible_product_ids','eligible_category_ids','excluded_product_ids','excluded_category_ids','eligible_customer_ids'])if(!Array.isArray(next[field])||next[field].some(id=>typeof id!=='string'||!id.trim()))throw new Error(`${field} must be an array of IDs.`);
      const ids=[...new Set([...next.eligible_product_ids,...next.excluded_product_ids].map(String))];
      const products=next.eligible_product_ids.length&&!next.eligible_category_ids.length
        ? await Product.findAll({where:{id:ids},attributes:['id','price','costPrice','categoryId'],transaction})
        : await Product.findAll({attributes:['id','price','costPrice','categoryId'],transaction});
      if(ids.some(id=>!products.some(p=>String(p.id)===id)))throw new Error('One or more products do not exist.');
      const margin=await getPolicy(transaction);
      const financial=await calculatePromotionFinancials({promotion:next,products,threshold:margin});
      financial.financialFingerprint=promotionFinancialFingerprint(next,products,margin);
      const risk=classifyPromotionFinancials(financial,margin);
      const status=risk==='unverifiable'||risk==='manager_and_owner'?'pending_approval':risk==='owner_loss'?'pending_owner_approval':'draft';
      const rows=await sequelize.query(`UPDATE promotions SET name=:name,description=:description,discount_type=:discountType,discount_value=:discountValue,max_discount=:maxDiscount,starts_at=:startsAt,ends_at=:endsAt,min_order_amount=:minOrderAmount,max_uses=:maxUses,max_uses_per_customer=:maxUsesPerCustomer,eligible_product_ids=:productIds,eligible_category_ids=:categoryIds,excluded_product_ids=:excludedIds,excluded_category_ids=:excludedCategoryIds,eligible_customer_ids=:customerIds,campaign_id=:campaignId,allow_stacking=:allowStacking,priority=:priority,settings_version=settings_version+1,status=:status,margin_snapshot=:grossMargin,profit_snapshot=:grossProfit,expected_loss=:expectedLoss,loss_making=:lossMaking,updated_at=now() WHERE id=:id RETURNING *`,{type:QueryTypes.SELECT,transaction,replacements:{id:current.id,name:next.name,description:next.description,discountType:next.discount_type,discountValue:next.discount_value,maxDiscount:next.max_discount,startsAt:next.starts_at,endsAt:next.ends_at,minOrderAmount:next.min_order_amount,maxUses:next.max_uses,maxUsesPerCustomer:next.max_uses_per_customer,productIds:next.eligible_product_ids,categoryIds:next.eligible_category_ids,excludedIds:next.excluded_product_ids,excludedCategoryIds:next.excluded_category_ids,customerIds:next.eligible_customer_ids,campaignId:next.campaign_id,allowStacking:next.allow_stacking,priority:next.priority,status, grossMargin:financial.grossMargin,grossProfit:financial.grossProfit,expectedLoss:financial.expectedLoss||0,lossMaking:financial.lossMaking}});
      await audit(transaction,current.id,req.user.id,'settings_changed',{version:rows[0].settings_version,financial});
      return {promotion:rows[0],financial};
    });
    res.json({success:true,data:promotionDto(output,req)});
    if(output.promotion.status==='pending_owner_approval')await notifyRoles(['owner'],'Promotion needs Owner approval',`${output.promotion.name} was changed and needs review.`,{promotionId:output.promotion.id});
    else if(output.promotion.status==='pending_approval')await notifyRoles(['owner','manager'],'Promotion needs approval',`${output.promotion.name} was changed and needs financial review.`,{promotionId:output.promotion.id});
  }catch(e){res.status(e.status||400).json({success:false,message:e.message});}
});

router.post('/:id/pause', async (req,res) => {
  if (!canManage(req)) return fail(res,403,'Promotion access denied.');
  try { await sequelize.transaction(async(transaction)=>{ const rows=await sequelize.query('UPDATE promotions SET status=:status,settings_version=settings_version+1,updated_at=now() WHERE id=:id RETURNING *',{type:QueryTypes.SELECT,transaction,replacements:{id:req.params.id,status:req.body.status==='cancelled'?'cancelled':'paused'}}); if(!rows[0]) throw Object.assign(new Error('Promotion not found.'),{status:404}); await audit(transaction,req.params.id,req.user.id,rows[0].status,{}); }); res.json({success:true}); }
  catch(e){res.status(e.status||400).json({success:false,message:e.message});}
});

router.post('/:id/activate',async(req,res)=>{
  if(!canManage(req))return fail(res,403,'Promotion access denied.');
  try{
    const row=await sequelize.transaction(async(transaction)=>{
      const p=(await sequelize.query('SELECT * FROM promotions WHERE id=:id FOR UPDATE',{type:QueryTypes.SELECT,transaction,replacements:{id:req.params.id}}))[0];
      if(!p)throw Object.assign(new Error('Promotion not found.'),{status:404});
      if(!['draft','paused','scheduled'].includes(p.status))throw Object.assign(new Error('Only draft, paused, or scheduled promotions can be activated.'),{status:409});
      if(['pending_approval','partially_approved','pending_owner_approval','rejected','cancelled'].includes(p.status))throw Object.assign(new Error('Promotion cannot be activated before required review.'),{status:409});
      const threshold=await getPolicy(transaction);
      const products=await Product.findAll({attributes:['id','price','costPrice','categoryId'],transaction});
      const financial=await calculatePromotionFinancials({promotion:p,products,threshold});
      const risk=classifyPromotionFinancials(financial,threshold);
      if(risk==='unverifiable')throw Object.assign(new Error('Profitability is unknown. Verify product costs before activation.'),{status:409});
      const fingerprint=promotionFinancialFingerprint(p,products,threshold);
      const approvals=await sequelize.query('SELECT reviewer_id,reviewer_role,decision,acknowledged_loss,reason,financial_snapshot FROM promotion_approvals WHERE promotion_id=:id AND settings_version=:version',{type:QueryTypes.SELECT,transaction,replacements:{id:p.id,version:p.settings_version}});
      const current=approvals.filter(a=>a.decision==='approved'&&a.financial_snapshot?.financialFingerprint===fingerprint);
      const ownerApproval=current.find(a=>a.reviewer_role==='owner');
      const managerApproval=current.find(a=>a.reviewer_role==='manager');
      if(risk==='owner_loss'&&(!ownerApproval||!ownerApproval.acknowledged_loss||!String(ownerApproval.reason||'').trim()))throw Object.assign(new Error('Current loss exposure requires a renewed Owner approval.'),{status:409});
      if(risk==='manager_and_owner'&&(!ownerApproval||!managerApproval||String(ownerApproval.reviewer_id)===String(managerApproval.reviewer_id)))throw Object.assign(new Error('Current margin requires distinct Manager and Owner approvals.'),{status:409});
      const status=p.starts_at&&new Date(p.starts_at)>new Date()?'scheduled':'active';
      const updated=(await sequelize.query('UPDATE promotions SET status=:status,updated_at=now() WHERE id=:id RETURNING *',{type:QueryTypes.SELECT,transaction,replacements:{id:p.id,status}}))[0];
      await audit(transaction,p.id,req.user.id,'activated',{status});
      return updated;
    });
    res.json({success:true,data:promotionDto(row,req)});
  }catch(e){res.status(e.status||400).json({success:false,message:e.message});}
});

// Keep old clients compatible while routing every quote through authoritative cart pricing.
router.post('/automatic/quote',sendCheckoutPreview);
router.post('/quote',sendCheckoutPreview);

// Owner-only, two-step policy changes: staff propose; Owner explicitly decides.
router.post('/policy/proposals', async(req,res)=>{
  if(!isManager(req)) return fail(res,403,'Only a Manager can propose a lower margin threshold.');
  const value=Number(req.body?.threshold), reason=String(req.body?.reason||'').trim();
  if(!Number.isFinite(value)||value<0||!reason) return fail(res,400,'Provide a non-negative threshold and a reason.');
  try {const rows=await sequelize.query(`INSERT INTO promotion_policy_proposals(previous_threshold,proposed_threshold,reason,proposed_by) SELECT minimum_gross_margin,:value,:reason,:userId FROM promotion_policy WHERE id=true AND :value<minimum_gross_margin RETURNING *`,{type:QueryTypes.INSERT,replacements:{value,reason,userId:req.user.id}});const row=Array.isArray(rows[0])?rows[0][0]:rows[0];if(!row)return fail(res,400,'A Manager can only propose lowering the current threshold.');res.status(201).json({success:true,data:row});}
  catch(e){res.status(400).json({success:false,message:e.message});}
});
router.put('/policy',async(req,res)=>{
  if(!owner(req))return fail(res,403,'Only the Owner can set the margin threshold directly.');
  const value=Number(req.body?.threshold),reason=String(req.body?.reason||'').trim();
  if(!Number.isFinite(value)||value<0||value>100||!reason)return fail(res,400,'Provide a threshold from 0% to 100% and a reason.');
  try{await sequelize.transaction(async(transaction)=>{const previous=await getPolicy(transaction);await sequelize.query('UPDATE promotion_policy SET minimum_gross_margin=:value,updated_by=:actor,updated_at=now() WHERE id=true',{transaction,replacements:{value,actor:req.user.id}});await audit(transaction,null,req.user.id,'margin_policy_changed',{previous,proposed:value,reason});});res.json({success:true,data:{minimumGrossMargin:value}});}
  catch(e){res.status(400).json({success:false,message:e.message});}
});
router.post('/policy/proposals/:id/decision',async(req,res)=>{
  if(!owner(req)) return fail(res,403,'Only the Owner can change the margin policy.');
  const approve=req.body?.decision==='approved'; if(!approve&&req.body?.decision!=='rejected')return fail(res,400,'Decision must be approved or rejected.');
  if(!String(req.body?.reason||'').trim())return fail(res,400,'Decision reason is required.');
  try {await sequelize.transaction(async(transaction)=>{const p=(await sequelize.query('SELECT * FROM promotion_policy_proposals WHERE id=:id AND status=\'pending\' FOR UPDATE',{type:QueryTypes.SELECT,transaction,replacements:{id:req.params.id}}))[0];if(!p)throw new Error('Pending proposal not found.');await sequelize.query('UPDATE promotion_policy_proposals SET status=:status,decided_by=:actor,decision_reason=:reason,decided_at=now() WHERE id=:id',{transaction,replacements:{status:approve?'approved':'rejected',actor:req.user.id,reason:req.body.reason,id:p.id}});if(approve){await sequelize.query('UPDATE promotion_policy SET minimum_gross_margin=:threshold,updated_by=:actor,updated_at=now() WHERE id=true',{transaction,replacements:{threshold:p.proposed_threshold,actor:req.user.id}});await audit(transaction,null,req.user.id,'margin_policy_changed',{previous:p.previous_threshold,proposed:p.proposed_threshold,reason:p.reason,decisionReason:req.body.reason});}});res.json({success:true});}
  catch(e){res.status(400).json({success:false,message:e.message});}
});

// Campaign setup uses only known customer IDs. No inferred segments are manufactured.
router.get('/campaigns/list',async(req,res)=>{if(!canManage(req))return fail(res,403,'Promotion access denied.');try{const rows=await sequelize.query(`SELECT c.*,
  (SELECT count(*) FROM promotions p WHERE p.campaign_id=c.id) AS promotion_count,
  (SELECT count(*) FROM promotion_redemptions r JOIN promotions p ON p.id=r.promotion_id WHERE p.campaign_id=c.id AND r.status='consumed') AS redemption_count,
  (SELECT coalesce(sum(r.discount_amount),0) FROM promotion_redemptions r JOIN promotions p ON p.id=r.promotion_id WHERE p.campaign_id=c.id AND r.status='consumed') AS discount_total,
  coalesce((SELECT json_agg(json_build_object('id',p.id,'name',p.name,'kind',p.kind,'status',p.status,'coupon_code',p.coupon_code,'discount_type',p.discount_type,'discount_value',p.discount_value) ORDER BY p.created_at DESC) FROM promotions p WHERE p.campaign_id=c.id),'[]'::json) AS promotions
  FROM promotion_campaigns c ORDER BY created_at DESC`,{type:QueryTypes.SELECT});res.json({success:true,data:rows});}catch(e){res.status(500).json({success:false,message:e.message});}});
router.post('/campaigns',async(req,res)=>{if(!canManage(req))return fail(res,403,'Promotion access denied.');const b=req.body||{};const start=b.startsAt?new Date(b.startsAt):null,end=b.endsAt?new Date(b.endsAt):null;const targets=b.targetCustomerIds||[];if(!String(b.name||'').trim())return fail(res,400,'Campaign name is required.');if((start&&!Number.isFinite(start.getTime()))||(end&&!Number.isFinite(end.getTime()))||(start&&end&&start>=end)||!Array.isArray(targets)||targets.some(id=>typeof id!=='string'))return fail(res,400,'Campaign dates or target customer IDs are invalid.');try{const rows=await sequelize.query(`INSERT INTO promotion_campaigns(name,description,starts_at,ends_at,status,target_customer_ids,created_by) VALUES(:name,:description,:starts,:ends,:status,:targets,:actor) RETURNING *`,{type:QueryTypes.INSERT,replacements:{name:String(b.name).trim(),description:b.description||null,starts:start,ends:end,status:b.status==='active'?'active':'draft',targets,actor:req.user.id}});res.status(201).json({success:true,data:Array.isArray(rows[0])?rows[0][0]:rows[0]});}catch(e){res.status(400).json({success:false,message:e.message});}});
router.patch('/campaigns/:id',async(req,res)=>{
  if(!canManage(req))return fail(res,403,'Promotion access denied.');
  const b=req.body||{};const allowed=['draft','active','paused','cancelled'];
  if(b.status!=null&&!allowed.includes(b.status))return fail(res,400,'Campaign status is invalid.');
  if(b.name!==undefined&&!String(b.name).trim())return fail(res,400,'Campaign name is required.');
  if(b.targetCustomerIds!==undefined&&(!Array.isArray(b.targetCustomerIds)||b.targetCustomerIds.some(id=>typeof id!=='string'||!id.trim())))return fail(res,400,'Target customers must be an array of IDs.');
  const starts=b.startsAt===undefined?undefined:(b.startsAt?new Date(b.startsAt):null);
  const ends=b.endsAt===undefined?undefined:(b.endsAt?new Date(b.endsAt):null);
  if((starts&&!Number.isFinite(starts.getTime()))||(ends&&!Number.isFinite(ends.getTime())))return fail(res,400,'Campaign dates are invalid.');
  try{
    const result=await sequelize.transaction(async(transaction)=>{
      const current=(await sequelize.query('SELECT * FROM promotion_campaigns WHERE id=:id FOR UPDATE',{type:QueryTypes.SELECT,transaction,replacements:{id:req.params.id}}))[0];
      if(!current)return null;
      const finalStart=b.startsAt===undefined?current.starts_at:starts;
      const finalEnd=b.endsAt===undefined?current.ends_at:ends;
      if(finalStart&&finalEnd&&new Date(finalStart)>=new Date(finalEnd))throw new Error('Campaign expiration must follow its start date.');
      const rows=await sequelize.query(`UPDATE promotion_campaigns SET name=coalesce(:name,name),description=CASE WHEN :hasDescription THEN :description ELSE description END,starts_at=CASE WHEN :hasStarts THEN :starts ELSE starts_at END,ends_at=CASE WHEN :hasEnds THEN :ends ELSE ends_at END,target_customer_ids=CASE WHEN :hasTargets THEN :targets ELSE target_customer_ids END,status=coalesce(:status,status),updated_at=now() WHERE id=:id RETURNING *`,{type:QueryTypes.SELECT,transaction,replacements:{id:req.params.id,name:b.name===undefined?null:String(b.name).trim(),hasDescription:b.description!==undefined,description:b.description??null,hasStarts:b.startsAt!==undefined,starts,hasEnds:b.endsAt!==undefined,ends,hasTargets:b.targetCustomerIds!==undefined,targets:b.targetCustomerIds||[],status:b.status||null}});
      const invalidated=[];
      if(b.startsAt!==undefined||b.endsAt!==undefined||b.targetCustomerIds!==undefined){
        const linked=await sequelize.query('SELECT * FROM promotions WHERE campaign_id=:campaignId FOR UPDATE',{type:QueryTypes.SELECT,transaction,replacements:{campaignId:req.params.id}});
        const products=await Product.findAll({attributes:['id','price','costPrice','categoryId'],transaction});
        const threshold=await getPolicy(transaction);
        for(const promotion of linked){
          const financial=await calculatePromotionFinancials({promotion,products,threshold});
          const status=!financial.costKnown||financial.grossMargin==null?'pending_approval':financial.lossMaking||financial.grossMargin<0?'pending_owner_approval':financial.grossMargin<threshold?'pending_approval':['active','scheduled'].includes(promotion.status)?promotion.status:'draft';
          const updated=(await sequelize.query(`UPDATE promotions SET settings_version=settings_version+1,status=:status,margin_snapshot=:margin,profit_snapshot=:profit,expected_loss=:loss,loss_making=:lossMaking,updated_at=now() WHERE id=:id RETURNING *`,{type:QueryTypes.SELECT,transaction,replacements:{id:promotion.id,status,margin:financial.grossMargin,profit:financial.grossProfit,loss:financial.expectedLoss||0,lossMaking:financial.lossMaking}}))[0];
          await audit(transaction,promotion.id,req.user.id,'campaign_settings_changed',{campaignId:req.params.id,version:updated.settings_version,financial});
          if(status==='pending_owner_approval')invalidated.push({id:promotion.id,name:promotion.name,status,expectedLoss:financial.expectedLoss});
          else if(status==='pending_approval')invalidated.push({id:promotion.id,name:promotion.name,status});
        }
      }
      await audit(transaction,null,req.user.id,'campaign_updated',{campaignId:rows[0].id,status:rows[0].status});
      return {campaign:rows[0],invalidated};
    });
    if(!result)return fail(res,404,'Campaign not found.');
    res.json(promotionDto({success:true,data:result.campaign,invalidatedPromotions:result.invalidated},req));
    if(result.invalidated.some(p=>p.status==='pending_owner_approval'))await notifyRoles(['owner'],'Campaign changes require promotion review',`${result.invalidated.length} linked promotion(s) require Owner review after a material campaign change.`,{campaignId:req.params.id});
    if(result.invalidated.some(p=>p.status==='pending_approval'))await notifyRoles(['owner','manager'],'Campaign changes require promotion review',`${result.invalidated.length} linked promotion(s) require financial review after a material campaign change.`,{campaignId:req.params.id});
  }catch(e){res.status(400).json({success:false,message:e.message});}
});

module.exports = router;
