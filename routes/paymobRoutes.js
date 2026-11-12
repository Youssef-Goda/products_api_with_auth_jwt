/**
 * paymobRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers Paymob payment routes under /api/v1/payments/paymob (set in server.js):
 *
 *   POST /initiate   — Customer-facing; requires JWT auth.
 *                      Body: { order_id, payment_method }
 *
 *   GET  /callback   — Public; Paymob redirects the customer's browser here
 *                      after a card payment attempt. Reads query params and
 *                      issues a 302 redirect to the Flutter web app status page.
 *                      Does NOT confirm the order (webhook does that).
 *
 *   POST /webhook    — Public; called by Paymob servers after payment attempt.
 *                      Uses express.raw() to capture the exact body for HMAC
 *                      verification (must NOT go through express.json() first).
 *
 * ⚠️  The webhook route MUST be registered BEFORE any global express.json()
 *      middleware.  See server.js for the correct mount order.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const express = require('express');
const router  = express.Router();
const sequelize = require('../config/database');
const User = require('../models/User');
const { QueryTypes } = require('sequelize');

const { authenticateToken }              = require('../middlewares/authMiddleware');
const { initiatePayment, handleWebhook, handleCallback } = require('../controllers/paymobController');

// ── Inline CORS headers (belt-and-suspenders) ────────────────────────────────
// The global cors() middleware in server.js already handles this, but because
// this router is mounted BEFORE express.json() (required for HMAC), we add
// explicit headers here as well to guarantee no preflight is ever blocked.
function setCorsHeaders(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  next();
}

router.use(setCorsHeaders);

// Handle pre-flight OPTIONS for all sub-paths under this router
router.options('*', (req, res) => res.sendStatus(200));

// ══════════════════════════════════════════════════════════════════════════════
// POST /initiate
// Protected endpoint — customer must supply a valid JWT.
// ══════════════════════════════════════════════════════════════════════════════
router.post('/initiate', authenticateToken, initiatePayment);

// Owner/Manager read-only visibility for ambiguous payment outcomes.
router.get('/reconciliation/attempts', authenticateToken, async(req,res)=>{
  try{
    const actor=await User.findByPk(req.user.id,{attributes:['id','role','isActive']});
    const role=String(actor?.role||'').toLowerCase();
    if(!actor||actor.isActive===false||!['owner','manager'].includes(role))return res.status(403).json({success:false,message:'Payment reconciliation access denied.'});
    const page=Math.max(1,Number.parseInt(req.query.page,10)||1);
    const pageSize=Math.min(100,Math.max(1,Number.parseInt(req.query.pageSize,10)||25));
    const offset=(page-1)*pageSize;
    const rows=await sequelize.query(`SELECT a.id AS attempt_reference,a.order_id AS order_reference,a.status,a.payment_method,
      a.provider_intention_id,a.provider_transaction_id,a.created_at,a.updated_at,a.expires_at,
      o.status AS order_status,o.payment_status
      FROM public.paymob_payment_attempts a LEFT JOIN public.orders o ON o.id=a.order_id
      WHERE a.status='reconciliation_required'
      ORDER BY a.updated_at ASC LIMIT :limit OFFSET :offset`,
      {type:QueryTypes.SELECT,replacements:{limit:pageSize,offset}});
    const [{count}]=await sequelize.query("SELECT count(*)::int AS count FROM public.paymob_payment_attempts WHERE status='reconciliation_required'",{type:QueryTypes.SELECT});
    return res.json({success:true,data:rows,pagination:{page,pageSize,total:count}});
  }catch(error){console.error('[Paymob] unresolved attempt listing failed:',error.message);return res.status(500).json({success:false,message:'Could not load unresolved payment attempts.'});}
});

// Records a review note only. It deliberately cannot change attempt/order
// payment states; only a verified Paymob webhook can establish payment.
router.post('/reconciliation/attempts/:id/review', (req,res,next)=>req.body!==undefined?next():express.json({limit:'16kb'})(req,res,next), authenticateToken, async(req,res)=>{
  try{
    const actor=await User.findByPk(req.user.id,{attributes:['id','role','isActive']});
    const role=String(actor?.role||'').toLowerCase();
    if(!actor||actor.isActive===false||!['owner','manager'].includes(role))return res.status(403).json({success:false,message:'Payment reconciliation access denied.'});
    const reason=String(req.body?.reason||'').trim();
    const evidenceReference=String(req.body?.evidenceReference||'').trim();
    if(!reason||reason.length>2000||!evidenceReference||evidenceReference.length>500)return res.status(400).json({success:false,message:'A reason and bounded evidence reference are required.'});
    const result=await sequelize.transaction(async(transaction)=>{
      const attempt=(await sequelize.query("SELECT id,order_id,status FROM public.paymob_payment_attempts WHERE id=:id FOR UPDATE",{type:QueryTypes.SELECT,transaction,replacements:{id:req.params.id}}))[0];
      if(!attempt)throw Object.assign(new Error('Payment attempt not found.'),{status:404});
      if(attempt.status!=='reconciliation_required')throw Object.assign(new Error('Only unresolved attempts can be reviewed.'),{status:409});
      const rows=await sequelize.query(`INSERT INTO public.paymob_attempt_reviews(attempt_id,reviewer_id,evidence_reference,reason,previous_status,resulting_status)
        VALUES(:attemptId,:reviewer,:evidence,:reason,:state,:state) RETURNING id,attempt_id,reviewer_id,evidence_reference,reason,previous_status,resulting_status,created_at`,
        {type:QueryTypes.INSERT,transaction,replacements:{attemptId:attempt.id,reviewer:actor.id,evidence:evidenceReference,reason, state:attempt.status}});
      return Array.isArray(rows[0])?rows[0][0]:rows[0];
    });
    return res.status(201).json({success:true,data:result,message:'Review recorded; payment remains unresolved until verified provider evidence is received.'});
  }catch(error){return res.status(error.status||500).json({success:false,message:error.status?error.message:'Could not record payment review.'});}
});

router.get('/reconciliation/attempts/:id/reviews', authenticateToken, async(req,res)=>{
  try{
    const actor=await User.findByPk(req.user.id,{attributes:['id','role','isActive']});
    if(!actor||actor.isActive===false||!['owner','manager'].includes(String(actor.role||'').toLowerCase()))return res.status(403).json({success:false,message:'Payment reconciliation access denied.'});
    const rows=await sequelize.query(`SELECT r.id,r.attempt_id,r.reviewer_id,r.evidence_reference,r.reason,
      r.previous_status,r.resulting_status,r.created_at
      FROM public.paymob_attempt_reviews r
      WHERE r.attempt_id=:attemptId ORDER BY r.created_at DESC`,
      {type:QueryTypes.SELECT,replacements:{attemptId:req.params.id}});
    return res.json({success:true,data:rows});
  }catch(error){console.error('[Paymob] review history read failed:',error.message);return res.status(500).json({success:false,message:'Could not load payment review history.'});}
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /callback & GET /webhook
// Public — Paymob redirects the customer's browser here after card payment.
// This is NOT a server-to-server call; it must NOT require JWT auth.
// The handler only reads the query params and redirects the browser to the
// Flutter web app checkout-status page. Order confirmation still comes from
// the HMAC-verified POST /webhook — never from this callback.
//
// ⚠️ router.get('/webhook', handleCallback) catches browser GET requests if
//    the Paymob dashboard Redirection URL was mistakenly set to /webhook.
// ══════════════════════════════════════════════════════════════════════════════
router.get('/callback', handleCallback);
router.get('/webhook', handleCallback);

// ══════════════════════════════════════════════════════════════════════════════
// POST /webhook
// Public endpoint for Paymob servers.
// express.raw() captures the raw Buffer so paymobController can recompute
// the HMAC over the exact bytes Paymob signed.
// ══════════════════════════════════════════════════════════════════════════════
router.post(
  '/webhook',
  express.raw({ type: 'application/json', limit: '1mb' }),
  handleWebhook
);

module.exports = router;

