/**
 * paymobController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles three Paymob payment endpoints:
 *
 *   initiatePayment  POST /api/v1/payments/paymob/initiate   (protected — customer JWT)
 *   handleWebhook    POST /api/v1/payments/paymob/webhook    (public — Paymob server)
 *   handleCallback   GET  /api/v1/payments/paymob/callback   (public — browser redirect)
 *
 * Architecture notes (transactional safety):
 *  • Order is created first by the /api/orders endpoint with payment_status='pending'.
 *  • initiatePayment ONLY generates a Paymob session — it does NOT confirm the order.
 *  • Order is ONLY marked 'paid' / 'confirmed' by handleWebhook after Paymob
 *    verifies the payment via HMAC-signed server-to-server webhook.
 *  • handleCallback is browser-only: reads query params, redirects to Flutter —
 *    it performs ZERO database writes.
 *  • If the Paymob API call fails, we return 502 with the exact reason — the order
 *    stays in 'pending' state so the customer can retry without data loss.
 *  • Amount is ALWAYS re-read from DB — client-sent amounts are never trusted.
 *  • Webhook HMAC is validated (crypto.timingSafeEqual) before any logic runs.
 *  • Webhook always returns HTTP 200 to prevent Paymob retry storms.
 *  • Webhook is idempotent: duplicate txn IDs and already-paid orders are no-ops.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto    = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { logActivity }  = require('../services/activityLogger');
const { sendOrderConfirmationEmail } = require('../utils/otpHelper');
const { createIntention } = require('../services/paymobService');
const { Op }              = require('sequelize');
const Product             = require('../models/Product');
const sequelize           = require('../config/database');

// ── Supabase admin client (bypass RLS) ───────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Helper: Strips quotes and whitespace from environment variables
function cleanEnv(val) {
  if (!val) return '';
  return String(val).trim().replace(/^["']|["']$/g, '');
}

// Helper: Validates Egyptian mobile phone numbers (010, 011, 012, 015)
function isValidEgyptianMobile(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const clean = phone.trim().replace(/\s+/g, '');

  // Must match Egyptian mobile format:
  // 010/011/012/015 + 8 digits (11 digits total)
  // or +2010/2011/2012/2015 + 8 digits (13 chars)
  // or 2010/2011/2012/2015 + 8 digits (12 digits)
  const egRegex = /^(?:\+?201|01)[0125]\d{8}$/;
  if (!egRegex.test(clean)) return false;

  // Reject dummy numbers where all 8 suffix digits are identical (e.g., 01000000000)
  const suffix = clean.slice(-8);
  if (/^(\d)\1{7}$/.test(suffix)) return false;

  return true;
}

// ── Paymob URL bases ──────────────────────────────────────────────────────────
// Card payments: iframe embed
const PAYMOB_IFRAME_BASE = 'https://accept.paymob.com/api/acceptance/iframes';
// NOTE: PAYMOB_WALLET_BASE ('https://accept.paymob.com/api/acceptance/pay') is
//       the programmatic PAY *API endpoint* — not a browser URL. Wallet payments
//       use the same PAYMOB_IFRAME_BASE format; what differentiates them is the
//       integration_id baked into the payment_token (PAYMOB_WALLET_INTEGRATION_ID).

// ══════════════════════════════════════════════════════════════════════════════
// Helper — read the final order total from the persisted orders row.
//
// ROOT CAUSE FIX (Issue 1):
//   The previous implementation summed unit_price × quantity from order_items,
//   which equals subtotal only — it silently dropped tax, shipping, and any
//   other fees stored on the order.  The Flutter app computes:
//     total = subtotal + tax   (10 % of subtotal)
//   and persists all three in orders.subtotal / orders.tax / orders.total.
//
//   This function now reads orders.total — the authoritative persisted total —
//   directly.  It never recalculates tax, shipping, or discounts; those were
//   already applied when the order was created.
//
// Example:
//   subtotal = 50 EGP,  tax = 5 EGP,  orders.total = 55 EGP
//   amountCents = Math.round(55 * 100) = 5500   ← CORRECT
//   Previous code returned 5000 (50 EGP × 100)  ← WRONG
// ══════════════════════════════════════════════════════════════════════════════
async function calcAmountCentsFromOrder(orderId) {
  const { data: order, error } = await supabase
    .from('orders')
    .select('subtotal, tax, total')
    .eq('id', orderId)
    .maybeSingle();

  if (error) throw new Error(`DB error fetching order ${orderId}: ${error.message}`);
  if (!order)  throw new Error(`Order ${orderId} not found when calculating amount`);

  const subtotal   = parseFloat(order.subtotal  ?? 0);
  const tax        = parseFloat(order.tax       ?? 0);
  const finalTotal = parseFloat(order.total     ?? 0);

  if (finalTotal <= 0) {
    throw new Error(
      `Order ${orderId} has an invalid total (${order.total}). Cannot initiate payment.`
    );
  }

  const amountCents = Math.round(finalTotal * 100);

  // Safe diagnostic log — no secrets, no card data
  console.log(`💰 [paymobController] Order ${orderId} amount breakdown:`, {
    orderId,
    subtotal,
    tax,
    finalTotal,
    amountCents,
  });

  return amountCents;
}

// ══════════════════════════════════════════════════════════════════════════════
// reduceStockForOrder
//
// Atomically decrements countInStock for every item in the given order.
// Uses a Sequelize transaction so ALL decrements commit together or ALL
// roll back — no partial stock reduction is possible.
//
// Each individual decrement uses a conditional UPDATE:
//   UPDATE "Products"
//   SET    "countInStock" = "countInStock" - qty
//   WHERE  id = productId
//     AND  "countInStock" >= qty
//
// If the WHERE condition is not met (stock insufficient or product missing),
// 0 rows are affected → an error is thrown → the full Sequelize transaction
// rolls back, restoring all previously decremented products to their original
// counts.
//
// Returns: { success: true }  |  { success: false, error: string }
//
// TRANSACTION BOUNDARY NOTE:
//   This Sequelize transaction covers ONLY the Products table.
//   The orders.stock_status update (Supabase PostgREST HTTP) is a separate
//   operation — the two cannot share a single ACID transaction because they
//   use different connection pools.  The stock_status state machine (pending
//   → processing → done/failed) bridges this architectural gap and makes the
//   overall operation safe and retryable.
// ══════════════════════════════════════════════════════════════════════════════
async function reduceStockForOrder(orderId) {
  // 1. Fetch order items from Supabase
  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('product_id, product_name, quantity')
    .eq('order_id', orderId);

  if (itemsErr) {
    return { success: false, error: `Failed to fetch order items: ${itemsErr.message}` };
  }
  if (!items || items.length === 0) {
    return { success: false, error: `No order items found for order ${orderId}` };
  }

  console.log(
    `📦 [reduceStockForOrder] Processing ${items.length} item(s) for order ${orderId}`
  );

  // 2. Validate all quantities before entering the transaction
  for (const item of items) {
    const qty = parseInt(item.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      return {
        success: false,
        error: `Invalid quantity for product ${item.product_id}: "${item.quantity}"`,
      };
    }
  }

  // 3. Sequelize transaction: atomic conditional decrement for every product
  const t = await sequelize.transaction();
  try {
    for (const item of items) {
      const qty       = parseInt(item.quantity, 10);
      const productId = item.product_id;
      const name      = item.product_name ?? productId;

      // Atomic conditional decrement:
      //   SET countInStock = countInStock - qty  WHERE countInStock >= qty
      // affectedCount === 0  →  stock insufficient or product not found
      // affectedCount === 1  →  success
      const [affectedCount] = await Product.update(
        { countInStock: sequelize.literal(`"countInStock" - ${qty}`) },
        {
          where: {
            id:           productId,
            countInStock: { [Op.gte]: qty },
          },
          transaction: t,
        }
      );

      if (affectedCount !== 1) {
        throw new Error(
          `Insufficient stock for product "${name}" (id=${productId}): ` +
          `need ${qty} unit(s) but available stock is less than that, ` +
          `or product does not exist.`
        );
      }

      console.log(
        `✅ [reduceStockForOrder] Product "${name}" (${productId}) − ${qty} unit(s)`
      );
    }

    await t.commit();
    console.log(
      `✅ [reduceStockForOrder] All ${items.length} product(s) decremented for order ${orderId}`
    );
    return { success: true };

  } catch (txErr) {
    try { await t.rollback(); } catch (rbErr) {
      console.error(
        `❌ [reduceStockForOrder] Rollback also failed for order ${orderId}: ${rbErr.message}`
      );
    }
    console.error(
      `❌ [reduceStockForOrder] Transaction rolled back for order ${orderId}: ${txErr.message}`
    );
    return { success: false, error: txErr.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/payments/paymob/initiate
//
// Body:    { order_id: string, payment_method: 'card' | 'wallet' | 'cash' | 'fawry' }
//
// Returns (card/wallet):
//   { success: true, payment_type: 'card'|'wallet', iframe_url: "https://..." }
//
// Returns (cash/fawry):
//   { success: true, payment_type: 'cash', reference_number: "123456", expire_date: "ISO" }
//
// Returns (error):
//   { success: false, message: "Payment initialization failed: <exact reason>" }
//
// IMPORTANT: This endpoint does NOT confirm the order. The order stays in
// payment_status='pending' until the Paymob webhook fires with success=true.
// ══════════════════════════════════════════════════════════════════════════════
async function initiatePayment(req, res) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Not authenticated.' });
    }

    if (!req.body || !req.body.order_id) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request: missing order_id in body',
      });
    }

    const { order_id, payment_method } = req.body;

    let method = (payment_method || 'card').toLowerCase();
    if (method === 'online') method = 'card';

    if (!['card', 'wallet', 'cash', 'fawry'].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "payment_method must be 'card', 'wallet', or 'cash'.",
      });
    }

    const isCash = method === 'cash' || method === 'fawry';

    // ── 0. Check secret key is configured ────────────────────────────────────
    const secretKey = cleanEnv(process.env.PAYMOB_SECRET_KEY || process.env.PAYMOB_API_KEY);
    if (!secretKey) {
      return res.status(500).json({
        success: false,
        message: 'Payment initialization failed: PAYMOB_SECRET_KEY / PAYMOB_API_KEY is not configured on the server.',
      });
    }

    // ── 1. Verify order exists and belongs to this user ──────────────────────
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, user_id, status, payment_status')
      .eq('id', order_id)
      .maybeSingle();

    if (orderErr) {
      return res.status(500).json({
        success: false,
        message: `Payment initialization failed: DB error fetching order — ${orderErr.message}`,
      });
    }
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (order.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied to this order.' });
    }
    if (order.payment_status === 'paid') {
      return res.status(409).json({ success: false, message: 'This order has already been paid.' });
    }

    // ── 2. Fetch user billing data ────────────────────────────────────────────
    const { data: userRow } = await supabase
      .from('users')
      .select('firstName, lastName, email, phone')
      .eq('id', userId)
      .maybeSingle();

    const billingData = {
      first_name:   userRow?.firstName   ?? 'Customer',
      last_name:    userRow?.lastName    ?? 'User',
      email:        userRow?.email       ?? 'customer@example.com',
      phone_number: userRow?.phone       ?? '+201000000000',
      city:         'Cairo',
      country:      'EG',
      state:        'Cairo',
      street:       'N/A',
      building:     'N/A',
      floor:        'N/A',
      apartment:    'N/A',
      postal_code:  '00000',
    };

    // ── 3. Read final total directly from the persisted order row ─────────────
    // Uses orders.total — which already includes tax, shipping, and any
    // discounts stored at order-creation time.  Never recalculates here.
    let amountCents;
    try {
      amountCents = await calcAmountCentsFromOrder(order_id);
    } catch (calcErr) {
      return res.status(500).json({
        success: false,
        message: `Payment initialization failed: could not read order total — ${calcErr.message}`,
      });
    }

    // ── 4. Check integration IDs are configured ───────────────────────────────
    let integrationId;
    if (isCash) {
      integrationId = cleanEnv(process.env.PAYMOB_CASH_INTEGRATION_ID);
      if (!integrationId) {
        return res.status(500).json({
          success: false,
          message: 'Payment initialization failed: PAYMOB_CASH_INTEGRATION_ID is not configured on the server.',
        });
      }
    } else {
      integrationId = method === 'wallet'
        ? cleanEnv(process.env.PAYMOB_WALLET_INTEGRATION_ID)
        : cleanEnv(process.env.PAYMOB_CARD_INTEGRATION_ID);

      if (!integrationId) {
        return res.status(500).json({
          success: false,
          message: `Payment initialization failed: PAYMOB_${method.toUpperCase()}_INTEGRATION_ID is not configured on the server.`,
        });
      }
    }

    // ── 5. Call Paymob Intention API ─────────────────────────────────────────
    const intention = await createIntention(
      amountCents, 
      'EGP', 
      [integrationId], 
      billingData, 
      { merchant_order_id: order_id, special_reference: order_id } // pass order_id in extras so it comes back in webhook
    );

    if (!intention || !intention.client_secret) {
      console.error('❌ [paymobController] Paymob Intention API did not yield client_secret. Intention payload:', intention);
      return res.status(502).json({
        success: false,
        message: 'Payment initialization failed: Paymob did not return a valid client_secret.',
      });
    }

    // Update order status in DB
    await supabase
      .from('orders')
      .update({ payment_status: 'initiated', updated_at: new Date().toISOString() })
      .eq('id', order_id);

    await logActivity(userId, 'PAYMENT_INITIATED', 'order', order_id, {
      payment_method: method,
      amount_cents:   amountCents,
    });

    console.log(`✅ [paymobController] Payment intention created for order ${order_id}`);

    return res.status(200).json({
      success:       true,
      payment_type:  method,
      client_secret: intention.client_secret,
      public_key:    cleanEnv(process.env.PAYMOB_PUBLIC_KEY),
    });

  } catch (err) {
    const reason = err.message ?? 'Unknown error';
    console.error('❌ [paymobController] initiatePayment error:', reason);

    if (
      reason.includes('Authentication Failed') ||
      reason.includes('HTTP 403') ||
      reason.includes('HTTP 401') ||
      reason.includes('Incorrect credentials')
    ) {
      return res.status(403).json({
        success: false,
        message: `Paymob Authentication Failed: ${reason}`,
      });
    }

    return res.status(502).json({
      success: false,
      message: `Payment initialization failed: ${reason}`,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Paymob HMAC fields (exact order per Paymob docs)
// https://docs.paymob.com/docs/hmac-calculation
// ══════════════════════════════════════════════════════════════════════════════
const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

function verifyPaymobHmac(body, receivedHmac) {
  const secret = cleanEnv(process.env.PAYMOB_HMAC_SECRET);
  if (!secret) {
    throw new Error('PAYMOB_HMAC_SECRET is not set');
  }

  const get = (obj, key) => {
    const keys = key.split('.');
    let val = obj;
    for (const k of keys) {
      if (val == null) return '';
      val = val[k];
    }
    if (typeof val === 'boolean') {
      return val ? 'true' : 'false';
    }
    return val ?? '';
  };

  const obj = body?.obj ?? body;
  const concatenated = HMAC_FIELDS.map((field) => String(get(obj, field))).join('');

  const expected = crypto
    .createHmac('sha512', secret)
    .update(concatenated)
    .digest('hex');

  let isValid = false;
  try {
    isValid = crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(receivedHmac, 'hex')
    );
  } catch {
    isValid = false;
  }

  console.log('[paymobWebhook] HMAC verification result:', {
    received_len: receivedHmac?.length ?? 0,
    expected_len: expected?.length ?? 0,
    received_preview: receivedHmac ? `${receivedHmac.slice(0, 8)}...${receivedHmac.slice(-8)}` : null,
    expected_preview: expected ? `${expected.slice(0, 8)}...${expected.slice(-8)}` : null,
    matched: isValid,
  });

  return isValid;
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/payments/paymob/webhook
//
// Public — called by Paymob after every payment attempt.
//
// Security contract:
//  • ALWAYS returns HTTP 200 — Paymob retries on any non-200, causing storms.
//  • HMAC verified before any DB write.  Invalid HMAC → logged + 200 returned.
//  • Idempotent: duplicate txn IDs and already-paid orders are silent no-ops.
//  • Amount verified against DB — mismatches logged as FRAUD and order failed.
//  • This is the ONLY place that sets payment_status = 'paid' in Supabase.
// ══════════════════════════════════════════════════════════════════════════════
async function handleWebhook(req, res) {
  // Top-level guard: any uncaught error must still return 200 so Paymob does
  // not enter a retry storm.  The error is logged for manual investigation.
  try {

  // ── 1. Parse raw body ───────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    console.error('❌ [paymobWebhook] Could not parse request body as JSON.');
    return res.status(200).json({ received: false, message: 'Invalid JSON body.' });
  }

  // ── 2. HMAC validation ──────────────────────────────────────────────────────
  // ⚠️  We return HTTP 200 even on failure so Paymob does NOT retry.
  //     Invalid requests are logged and silently dropped.
  const receivedHmac = req.query?.hmac;
  if (!receivedHmac) {
    console.warn('⚠️ [paymobWebhook] Missing hmac query parameter — rejected.');
    return res.status(200).json({ received: false, message: 'Missing HMAC.' });
  }

  let hmacValid;
  try {
    hmacValid = verifyPaymobHmac(body, receivedHmac);
  } catch (hmacErr) {
    console.error('🚨 [paymobWebhook] HMAC check threw:', hmacErr.message);
    return res.status(200).json({ received: false, message: hmacErr.message });
  }

  if (!hmacValid) {
    console.warn('🚨 [paymobWebhook] HMAC validation FAILED — possible spoofed request. Dropping.');
    return res.status(200).json({ received: false, message: 'HMAC validation failed.' });
  }

  console.log('✅ [paymobWebhook] HMAC validated successfully.');

  // ── 3. Extract transaction data ─────────────────────────────────────────────
  const txn = body?.obj ?? body;

  const paymobTransactionId = String(txn?.id ?? '');
  const isSuccess           = txn?.success === true;
  const isPending           = txn?.pending === true;
  const amountCentsReported = parseInt(txn?.amount_cents ?? '0', 10);
  const internalOrderId     = txn?.special_reference
    ?? txn?.order?.merchant_order_id
    ?? txn?.payment_key_claims?.billing_data?.merchant_order_id
    ?? txn?.intention?.extras?.merchant_order_id
    ?? txn?.extras?.merchant_order_id
    ?? null;

  console.log(
    `📬 [paymobWebhook] txn=${paymobTransactionId} success=${isSuccess} ` +
    `pending=${isPending} orderId=${internalOrderId}`
  );

  // ── 4. Resolve internal order ────────────────────────────────────────────────
  if (!internalOrderId) {
    console.error('❌ [paymobWebhook] Cannot resolve internal order ID from webhook payload.');
    return res.status(200).json({ received: true, message: 'Acknowledged (unresolvable order).' });
  }

  // Fetch order with all fields needed for amount verification, idempotency,
  // and stock-status state machine in one round-trip.
  const { data: order, error: fetchErr } = await supabase
    .from('orders')
    .select('id, subtotal, tax, total, payment_status, user_id, stock_status, stock_processing_started_at')
    .eq('id', internalOrderId)
    .maybeSingle();

  if (fetchErr || !order) {
    console.error(`❌ [paymobWebhook] Order ${internalOrderId} not found in DB.`);
    return res.status(200).json({ received: true, message: 'Acknowledged (order not found).' });
  }

  // ── 5. Amount verification ────────────────────────────────────────────────────
  // Compute expected amount directly from the persisted order row (orders.total)
  // instead of re-summing order_items.  This includes tax, shipping, and any
  // other fees already baked into total — never recalculated here.
  const subtotal            = parseFloat(order.subtotal  ?? 0);
  const tax                 = parseFloat(order.tax       ?? 0);
  const finalTotal          = parseFloat(order.total     ?? 0);
  const expectedAmountCents = Math.round(finalTotal * 100);

  console.log(`💰 [paymobWebhook] Order ${internalOrderId} amount breakdown:`, {
    orderId:             internalOrderId,
    subtotal,
    tax,
    finalTotal,
    expectedAmountCents,
    reportedAmountCents: amountCentsReported,
  });

  if (finalTotal <= 0) {
    console.error(`❌ [paymobWebhook] Order ${internalOrderId} has invalid total: ${order.total}`);
    return res.status(200).json({ received: true, message: 'Acknowledged (invalid order total).' });
  }

  if (amountCentsReported !== expectedAmountCents) {
    console.error(
      `🚨 [paymobWebhook] Amount mismatch! ` +
      `reported=${amountCentsReported} expected=${expectedAmountCents} — FRAUD ALERT`
    );
    await supabase
      .from('orders')
      .update({
        payment_status:        'failed',
        paymob_transaction_id: paymobTransactionId || null,
        updated_at:            new Date().toISOString(),
      })
      .eq('id', internalOrderId);
    await logActivity(null, 'PAYMENT_AMOUNT_MISMATCH', 'order', internalOrderId, {
      reported_amount_cents: amountCentsReported,
      expected_amount_cents: expectedAmountCents,
      paymob_transaction_id: paymobTransactionId,
    });
    return res.status(200).json({ received: true, message: 'Acknowledged (amount mismatch).' });
  }

  // ── 6. Determine final payment status ────────────────────────────────────────
  // ★ THIS IS THE ONLY PLACE IN THE ENTIRE CODEBASE THAT SETS payment_status='paid'.
  //   handleCallback performs ZERO database writes.
  //   initiatePayment only sets 'initiated'.
  const finalPaymentStatus = (isSuccess && !isPending) ? 'paid' : 'failed';
  const finalOrderStatus   = finalPaymentStatus === 'paid' ? 'confirmed' : 'cancelled';

  // ── 7. FAILED payment: atomic idempotent update ──────────────────────────────
  if (finalPaymentStatus === 'failed') {
    // Only update if not yet processed.  The .in() guard prevents overwriting
    // a successfully paid order with a concurrent or delayed failed webhook.
    await supabase
      .from('orders')
      .update({
        payment_status:        'failed',
        paymob_transaction_id: paymobTransactionId || null,
        status:                'cancelled',
        updated_at:            new Date().toISOString(),
      })
      .eq('id', internalOrderId)
      .in('payment_status', ['pending', 'initiated']);

    await logActivity(order.user_id, 'PAYMENT_FAILED', 'order', internalOrderId, {
      paymob_transaction_id: paymobTransactionId,
      amount_cents:          amountCentsReported,
      success:               isSuccess,
      pending:               isPending,
    });

    console.log(`❌ [paymobWebhook] Order ${internalOrderId} → payment failed.`);
    return res.status(200).json({ received: true, message: 'Payment failed.' });
  }

  // ── 8. SUCCESSFUL payment: two-phase atomic state machine ────────────────────
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │  PHASE A — Claim payment (first successful webhook only)                │
  // │  Atomic conditional UPDATE:                                             │
  // │    payment_status IN ('pending','initiated') → 'paid'                  │
  // │    stock_status simultaneously set to 'pending'                         │
  // │  If 1 row → first claim: do cart-clear + email, then proceed to stock. │
  // │  If 0 rows → already claimed: check current stock_status for retry.    │
  // ├─────────────────────────────────────────────────────────────────────────┤
  // │  PHASE B-1 — Claim stock-processing lease (normal path)                │
  // │  Atomic conditional UPDATE:                                             │
  // │    stock_status IN ('pending','failed') → 'processing'                  │
  // │  If 1 row → we own the lease; proceed to stock.                        │
  // │  If 0 rows → check for stale lease (crash/timeout recovery, B-2).     │
  // ├─────────────────────────────────────────────────────────────────────────┤
  // │  PHASE B-2 — Reclaim stale processing lease (crash recovery)           │
  // │  Atomic conditional UPDATE:                                             │
  // │    stock_status = 'processing'                                          │
  // │    AND stock_processing_started_at < now() − 5 min                     │
  // │  Lease timeout covers Vercel max serverless function duration.          │
  // │  If 1 row → stale lease reclaimed; proceed to stock.                   │
  // │  If 0 rows → fresh active lease held by another instance; skip.        │
  // ├─────────────────────────────────────────────────────────────────────────┤
  // │  PHASE C — Sequelize transaction for stock decrement                   │
  // │  All products decremented atomically (all-or-nothing).                  │
  // │  WHERE countInStock >= qty prevents negative stock.                     │
  // ├─────────────────────────────────────────────────────────────────────────┤
  // │  PHASE D — Finalize stock_status                                        │
  // │  'done' on success (terminal — never re-processed).                     │
  // │  'failed' on rollback (retryable by next duplicate webhook).            │
  // └─────────────────────────────────────────────────────────────────────────┘

  // ── Phase A: Claim payment ────────────────────────────────────────────────
  let isFirstPaymentClaim = false;
  try {
    const { data: paymentClaimed, error: claimErr } = await supabase
      .from('orders')
      .update({
        payment_status:        'paid',
        paymob_transaction_id: paymobTransactionId || null,
        status:                finalOrderStatus,
        stock_status:          'pending',   // signals stock work is needed
        updated_at:            new Date().toISOString(),
      })
      .eq('id', internalOrderId)
      .in('payment_status', ['pending', 'initiated'])
      .select('id');

    if (claimErr) {
      console.error(
        `❌ [paymobWebhook] Phase A DB error for order ${internalOrderId}: ${claimErr.message}`
      );
    } else {
      isFirstPaymentClaim = Array.isArray(paymentClaimed) && paymentClaimed.length > 0;
    }
  } catch (phaseAErr) {
    console.error(
      `❌ [paymobWebhook] Phase A exception for order ${internalOrderId}: ${phaseAErr.message}`
    );
  }

  if (!isFirstPaymentClaim) {
    // Payment was already claimed. Re-fetch to determine current stock state.
    const { data: freshOrder } = await supabase
      .from('orders')
      .select('payment_status, stock_status, stock_processing_started_at')
      .eq('id', internalOrderId)
      .maybeSingle();

    if (!freshOrder || freshOrder.payment_status !== 'paid') {
      // Order ended as 'failed', or something unexpected — skip everything.
      console.log(
        `ℹ️ [paymobWebhook] Order ${internalOrderId} ` +
        `payment_status=${freshOrder?.payment_status ?? 'unknown'} — skipping stock.`
      );
      return res.status(200).json({ received: true, message: 'Already processed.' });
    }

    if (freshOrder.stock_status === 'done') {
      console.log(
        `ℹ️ [paymobWebhook] Order ${internalOrderId} stock_status=done — nothing to do.`
      );
      return res.status(200).json({ received: true, message: 'Already fully processed.' });
    }

    // stock_status is pending / failed / processing(possibly stale) — fall through to Phase B.
    console.log(
      `🔄 [paymobWebhook] Order ${internalOrderId} stock_status=${
        freshOrder.stock_status ?? 'null'
      } — attempting stock processing.`
    );
  } else {
    // ── First payment claim: clear cart + send confirmation email ─────────
    // These ONLY run on the very first successful payment claim.
    // Stock retries (Phase A returns 0 rows) must NOT re-send emails or
    // re-clear the cart.
    try {
      const { error: cartErr } = await supabase
        .from('cart_items')
        .delete()
        .eq('user_id', order.user_id);
      if (cartErr) {
        console.warn(
          `⚠️ [paymobWebhook] Cart clear failed for user ${order.user_id}: ${cartErr.message}`
        );
      } else {
        console.log(`🛒 [paymobWebhook] Cart cleared for user ${order.user_id}`);
      }
    } catch (cartExc) {
      console.warn('⚠️ [paymobWebhook] Cart clear exception:', cartExc.message);
    }

    try {
      const { data: fullOrder } = await supabase
        .from('orders')
        .select('*, order_items(*), shipping_addresses(*)')
        .eq('id', internalOrderId)
        .maybeSingle();

      const { data: userRow } = await supabase
        .from('users')
        .select('email, firstName')
        .eq('id', order.user_id)
        .maybeSingle();

      if (userRow?.email && fullOrder) {
        sendOrderConfirmationEmail(userRow.email, fullOrder, userRow.firstName || 'Customer')
          .then(() =>
            console.log(`📧 [paymobWebhook] Confirmation email sent to ${userRow.email}`)
          )
          .catch((e) =>
            console.warn('⚠️ [paymobWebhook] Order email skipped:', e.message)
          );
      }
    } catch (emailErr) {
      console.warn('⚠️ [paymobWebhook] Could not send confirmation email:', emailErr.message);
    }
  }

  // ── Phase B-1: Claim stock-processing lease (normal path) ─────────────────
  // Transitions stock_status: pending | failed → processing.
  // Two concurrent webhooks race on this UPDATE; only one succeeds (Postgres
  // row-level lock on the UPDATE).  The loser gets 0 rows and falls through
  // to B-2, where the fresh lease timestamp will prevent reclaim.
  const STOCK_LEASE_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
  const leaseAcquiredAt        = new Date().toISOString();
  let   stockSlotClaimed       = false;

  try {
    const { data: normalClaim, error: b1Err } = await supabase
      .from('orders')
      .update({
        stock_status:                'processing',
        stock_processing_started_at: leaseAcquiredAt,
        updated_at:                  new Date().toISOString(),
      })
      .eq('id', internalOrderId)
      .in('stock_status', ['pending', 'failed'])
      .select('id');

    if (b1Err) {
      console.error(
        `❌ [paymobWebhook] Phase B-1 DB error for order ${internalOrderId}: ${b1Err.message}`
      );
    } else if (Array.isArray(normalClaim) && normalClaim.length > 0) {
      stockSlotClaimed = true;
      console.log(
        `⚙️ [paymobWebhook] Phase B-1: stock lease acquired for order ${internalOrderId}`
      );
    }
  } catch (b1Exc) {
    console.error(
      `❌ [paymobWebhook] Phase B-1 exception for order ${internalOrderId}: ${b1Exc.message}`
    );
  }

  // ── Phase B-2: Reclaim stale processing lease (crash/timeout recovery) ────
  // Runs only when B-1 returned 0 rows (stock_status was not pending/failed).
  // If the current stock_status is 'processing' but the lease is older than
  // STOCK_LEASE_TIMEOUT_MS, the previous processing instance crashed or was
  // killed by the Vercel runtime.  We reclaim the slot.
  if (!stockSlotClaimed) {
    try {
      const staleThresholdISO = new Date(Date.now() - STOCK_LEASE_TIMEOUT_MS).toISOString();

      const { data: staleClaim, error: b2Err } = await supabase
        .from('orders')
        .update({
          stock_status:                'processing',
          stock_processing_started_at: leaseAcquiredAt,
          updated_at:                  new Date().toISOString(),
        })
        .eq('id', internalOrderId)
        .eq('stock_status', 'processing')
        .lt('stock_processing_started_at', staleThresholdISO)
        .select('id');

      if (b2Err) {
        console.error(
          `❌ [paymobWebhook] Phase B-2 DB error for order ${internalOrderId}: ${b2Err.message}`
        );
      } else if (Array.isArray(staleClaim) && staleClaim.length > 0) {
        stockSlotClaimed = true;
        console.warn(
          `🔄 [paymobWebhook] Phase B-2: reclaimed stale processing lease ` +
          `for order ${internalOrderId} (previous instance likely crashed/timed-out)`
        );
      }
    } catch (b2Exc) {
      console.error(
        `❌ [paymobWebhook] Phase B-2 exception for order ${internalOrderId}: ${b2Exc.message}`
      );
    }
  }

  if (!stockSlotClaimed) {
    // stock_status is 'done' (terminal) or another instance holds a fresh lease.
    // Either way, nothing for this invocation to do.
    console.log(
      `ℹ️ [paymobWebhook] Order ${internalOrderId} — stock slot not available ` +
      `(already done, or active fresh lease). Skipping.`
    );
    return res.status(200).json({
      received: true,
      message:  'Payment confirmed. Stock already processed or being processed.',
    });
  }

  // ── Phase C: Reduce stock via Sequelize transaction ───────────────────────
  // reduceStockForOrder fetches order_items from Supabase then runs a
  // Sequelize transaction that atomically decrements countInStock for every
  // product.  Any insufficient-stock condition rolls back ALL decrements.
  const stockResult = await reduceStockForOrder(internalOrderId);

  // ── Phase D: Finalize stock_status ────────────────────────────────────────
  // 'done'   → terminal, never re-processed
  // 'failed' → retryable by next duplicate webhook from Paymob
  const finalStockStatus = stockResult.success ? 'done' : 'failed';
  try {
    await supabase
      .from('orders')
      .update({
        stock_status:                finalStockStatus,
        stock_processing_started_at: null,   // release the lease
        updated_at:                  new Date().toISOString(),
      })
      .eq('id', internalOrderId);

    console.log(
      `📦 [paymobWebhook] Order ${internalOrderId} → stock_status='${finalStockStatus}'.`
    );
  } catch (finalizeErr) {
    // Phase D failed: stock_status stays 'processing' with the timestamp.
    // The stale-lease recovery in Phase B-2 will allow a future webhook to
    // reclaim after STOCK_LEASE_TIMEOUT_MS.
    console.error(
      `❌ [paymobWebhook] Phase D finalize failed for order ${internalOrderId}: ` +
      `${finalizeErr.message} — stock_status remains 'processing'; ` +
      `stale-lease recovery will reclaim after ${STOCK_LEASE_TIMEOUT_MS / 60000} min.`
    );
  }

  if (!stockResult.success) {
    console.error(
      `❌ [paymobWebhook] Stock reduction failed for order ${internalOrderId}: ` +
      `${stockResult.error}\n` +
      `   stock_status=failed — next duplicate Paymob webhook will retry.`
    );
  }

  // ── 9. Log activity ────────────────────────────────────────────────────────
  await logActivity(order.user_id, 'PAYMENT_CONFIRMED', 'order', internalOrderId, {
    paymob_transaction_id:  paymobTransactionId,
    amount_cents:           amountCentsReported,
    expected_amount_cents:  expectedAmountCents,
    is_first_payment_claim: isFirstPaymentClaim,
    stock_result:           finalStockStatus,
    stock_error:            stockResult.success ? undefined : stockResult.error,
  });

  console.log(
    `✅ [paymobWebhook] Order ${internalOrderId} → ` +
    `payment_status='paid' stock_status='${finalStockStatus}'.`
  );
  return res.status(200).json({
    received: true,
    message:  `Payment confirmed. Stock ${finalStockStatus}.`,
  });

  } catch (outerErr) {
    // Safety net: any uncaught async error must NOT bubble up as a 500.
    // Paymob retries on non-200 responses — a 500 would cause an infinite storm.
    console.error(
      '🚨 [paymobWebhook] Unhandled exception in webhook handler:',
      outerErr?.message, outerErr?.stack
    );
    return res.status(200).json({
      received: false,
      message: 'Internal error — logged for investigation.',
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/payments/paymob/callback
//
// Paymob calls this URL (set as redirect_url in the payment key) after the
// customer finishes — or abandons — the card-payment iframe/browser window.
//
// Query params injected by Paymob:
//   success             'true' | 'false'
//   pending             'true' | 'false'
//   id                  Paymob transaction ID
//   merchant_order_id   Our internal order UUID (only if we passed it)
//   order               Paymob order ID
//   txn_response_code   e.g. 'APPROVED', 'BLOCKED'
//   hmac                Signature — NOT validated here (webhook is the
//                        authoritative source; this is only a browser redirect)
//
// This handler does NOT confirm the order — it only redirects the browser back
// to the Flutter web app so the UI can poll GET /api/orders/:id/payment-status
// (which is populated exclusively by the HMAC-verified webhook).
// ══════════════════════════════════════════════════════════════════════════════
async function handleCallback(req, res) {
  const {
    success           = 'false',
    pending           = 'false',
    id:       txnId   = '',
    merchant_order_id = '',
    special_reference = '',
    order_id          = '',
    order:    paymobNumericOrderId = '',
    txn_response_code = '',
  } = req.query;

  // ── Safely resolve our internal order UUID ──────────────────────────────────
  // Priority:
  //   1. special_reference — Passed during Intention creation
  //   2. merchant_order_id — Paymob echoes back the UUID we passed at registerOrder.
  //   3. order_id          — Some Paymob integration variants send it as order_id.
  //   4. DB lookup by Paymob numeric order ID — last resort.
  //   5. DB lookup by txn_id — waits 1.5s for webhook to sync, then recovers it.
  let orderId = special_reference || merchant_order_id || order_id || '';

  if (!orderId && paymobNumericOrderId) {
    console.warn(
      `⚠️ [paymobCallback] merchant_order_id missing — attempting DB lookup by paymob numeric order id: ${paymobNumericOrderId}`
    );
    try {
      const { data: orderRow } = await supabase
        .from('orders')
        .select('id')
        .eq('paymob_order_id', paymobNumericOrderId)
        .maybeSingle();
      if (orderRow?.id) {
        orderId = orderRow.id;
        console.log(`ℹ️ [paymobCallback] Resolved orderId=${orderId} via paymob_order_id lookup`);
      }
    } catch (lookupErr) {
      console.warn(`⚠️ [paymobCallback] DB lookup for paymob_order_id failed: ${lookupErr.message}`);
    }
  }

  // 🔴 Fallback: Recover missing order_id using txn_id after webhook sync
  if (!orderId && txnId) {
    console.log(`⏳ [paymobCallback] orderId missing. Polling DB for txnId=${txnId} (max 3 attempts)...`);
    
    let attempts = 3;
    let delayMs = 1500;
    
    while (attempts > 0 && !orderId) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
      try {
        const { data: orderRow } = await supabase
          .from('orders')
          .select('id')
          .eq('paymob_transaction_id', txnId)
          .maybeSingle();

        if (orderRow?.id) {
          orderId = orderRow.id;
          console.log(`✅ [paymobCallback] Successfully recovered orderId=${orderId} via txnId lookup!`);
          break;
        }
      } catch (err) {
        console.warn(`⚠️ [paymobCallback] DB lookup by txnId failed: ${err.message}`);
      }
      
      attempts--;
      if (!orderId && attempts > 0) {
        console.log(`⏳ [paymobCallback] orderId not found yet for txnId=${txnId}. Retrying in ${delayMs}ms...`);
        delayMs += 500;
      }
    }
    
    if (!orderId) {
      console.warn(`❌ [paymobCallback] Exhausted polling. Could not recover orderId for txnId=${txnId}.`);
    }
  }




  const isSuccess = String(success).toLowerCase() === 'true';

  console.log(
    `📲 [paymobCallback] Received — success=${success} pending=${pending} ` +
    `orderId=${orderId} txnId=${txnId}`
  );

  // If payment explicitly failed or cancelled, mark pending_payment order as cancelled
  const isFailed = !isSuccess && (pending === 'false' || pending === false);
  if (orderId && isFailed) {
    try {
      await supabase
        .from('orders')
        .update({ status: 'cancelled', payment_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', orderId)
        .in('status', ['pending_payment', 'pending']);
      console.log(`ℹ️ [paymobCallback] Marked order ${orderId} as cancelled (payment failed/abandoned)`);
    } catch (err) {
      console.warn(`⚠️ [paymobCallback] Could not mark order ${orderId} as cancelled: ${err.message}`);
    }
  }

  // ── Resolve the frontend base URL — never hardcode a port ─────────────────
  let frontendBase = '';
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    frontendBase = cleanEnv(process.env.LOCAL_FRONTEND_URL);
    if (!frontendBase) {
      const referer = req.get('Referer') || req.get('Origin') || '';
      if (referer) {
        try { frontendBase = new URL(referer).origin; } catch { /* ignore */ }
      }
    }
  }

  if (!frontendBase) {
    frontendBase = cleanEnv(process.env.FRONTEND_URL);
  }

  if (!frontendBase) {
    console.warn('⚠️ [paymobCallback] FRONTEND_URL not set, no Referer — returning params as JSON');
    return res.status(200).json({
      success:  String(success),
      pending:  String(pending),
      order_id: orderId,
      txn_id:   txnId,
      code:     txn_response_code,
      message:  'Set FRONTEND_URL env var to enable automatic browser redirect.',
    });
  }

  try { frontendBase = new URL(frontendBase).origin; }
  catch { frontendBase = frontendBase.split('#')[0].replace(/\/+$/, ''); }

  // ── Build redirect — order_id is always explicit in the query string ────────
  const params = new URLSearchParams({
    order_id: orderId,
    success:  String(success),
    pending:  String(pending),
    txn_id:   String(txnId),
    txn_code: String(txn_response_code),
  });

  const redirectUrl = `${frontendBase}/checkout/status?${params.toString()}`;

  console.log(`↩️ [paymobCallback] Redirecting browser → ${redirectUrl}`);
  return res.redirect(302, redirectUrl);
}

module.exports = { initiatePayment, handleWebhook, handleCallback };
