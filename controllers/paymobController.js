/**
 * paymobController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles the two Paymob payment endpoints:
 *
 *   initiatePayment  POST /api/v1/payments/paymob/initiate   (protected — customer JWT)
 *   handleWebhook    POST /api/v1/payments/paymob/webhook    (public — Paymob server)
 *
 * Security highlights:
 *  • Order amount is ALWAYS re-calculated from DB — never trusted from the request.
 *  • Webhook HMAC is validated before any business logic runs.
 *  • Duplicate webhook calls are detected via paymob_transaction_id uniqueness.
 *  • Secrets are never written to logs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const crypto    = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { logActivity }  = require('../services/activityLogger');
const {
  getAuthToken,
  registerOrder,
  generatePaymentKey,
  generateCashReference,
} = require('../services/paymobService');

// ── Supabase admin client (bypass RLS) ───────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Paymob iframe base URL ────────────────────────────────────────────────────
const PAYMOB_IFRAME_BASE = 'https://accept.paymob.com/api/acceptance/iframes';
const PAYMOB_WALLET_BASE = 'https://accept.paymob.com/api/acceptance/pay';

// ══════════════════════════════════════════════════════════════════════════════
// Helper — calculate the total amount (in piastres / cents) from order_items
// by reading from the database.  This is the single source of truth for amount.
// ══════════════════════════════════════════════════════════════════════════════
async function calcAmountCentsFromDB(orderId) {
  const { data: items, error } = await supabase
    .from('order_items')
    .select('unit_price, quantity')
    .eq('order_id', orderId);

  if (error) throw new Error(`DB error fetching order items: ${error.message}`);
  if (!items || items.length === 0) throw new Error(`No items found for order ${orderId}`);

  const totalEGP = items.reduce(
    (sum, item) => sum + parseFloat(item.unit_price) * parseInt(item.quantity, 10),
    0
  );

  // Paymob expects an integer in piastres (EGP × 100), rounded
  return Math.round(totalEGP * 100);
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/payments/paymob/initiate
// Protected — requires authenticateToken middleware (applied in routes).
//
// Body: { order_id: string, payment_method: 'card' | 'wallet' }
// Returns: { success, payment_url, payment_key, payment_type }
// ══════════════════════════════════════════════════════════════════════════════
async function initiatePayment(req, res) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Not authenticated.' });
  }

  const { order_id, payment_method } = req.body;

  if (!order_id) {
    return res.status(400).json({ success: false, message: 'order_id is required.' });
  }

  const method = (payment_method || 'card').toLowerCase();
  if (!['card', 'wallet', 'cash', 'fawry'].includes(method)) {
    return res.status(400).json({
      success: false,
      message: "payment_method must be 'card', 'wallet', or 'cash'.",
    });
  }

  // Normalise cash/fawry to a single label
  const isCash = method === 'cash' || method === 'fawry';

  try {
    // ── 1. Fetch order and verify ownership ───────────────────────────────
    const { data: order, error: orderErr } = await supabase
      .from('orders')
      .select('id, user_id, status, payment_status')
      .eq('id', order_id)
      .maybeSingle();

    if (orderErr) throw new Error(`DB error: ${orderErr.message}`);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }
    if (order.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Access denied to this order.' });
    }
    if (order.payment_status === 'paid') {
      return res.status(409).json({ success: false, message: 'This order has already been paid.' });
    }

    // ── 2. Fetch user billing info for Paymob ─────────────────────────────
    const { data: userRow } = await supabase
      .from('users')
      .select('firstName, lastName, email, phone')
      .eq('id', userId)
      .maybeSingle();

    const billingData = {
      first_name:   userRow?.firstName  ?? 'Customer',
      last_name:    userRow?.lastName   ?? 'User',
      email:        userRow?.email      ?? 'customer@example.com',
      phone_number: userRow?.phone      ?? '+201000000000',
      city:         'Cairo',
      country:      'EG',
      state:        'Cairo',
      street:       'N/A',
      building:     'N/A',
      floor:        'N/A',
      apartment:    'N/A',
      postal_code:  '00000',
    };

    // ── 3. Calculate amount strictly from DB ──────────────────────────────
    const amountCents = await calcAmountCentsFromDB(order_id);
    console.log(`💰 [paymobController] Order ${order_id} → amountCents=${amountCents}`);

    // ── 4. Select integration ID (not needed for cash — handled in generateCashReference) ─
    const integrationId = isCash ? null : method === 'wallet'
      ? process.env.PAYMOB_WALLET_INTEGRATION_ID
      : process.env.PAYMOB_CARD_INTEGRATION_ID;

    if (!isCash && !integrationId) {
      return res.status(500).json({
        success: false,
        message: `Payment method '${method}' is not configured on the server.`,
      });
    }

    // ── 5. Paymob flow ──────────────────────────────────────────────────
    const authToken   = await getAuthToken();
    const paymobOrder = await registerOrder(authToken, amountCents);

    // ── 6. Cash / Fawry branch: no iframe ──────────────────────────────
    if (isCash) {
      const { billReference, expiresAt } = await generateCashReference(
        authToken, paymobOrder, amountCents, billingData
      );

      await supabase
        .from('orders')
        .update({ payment_status: 'initiated', updated_at: new Date().toISOString() })
        .eq('id', order_id);

      await logActivity(userId, 'PAYMENT_INITIATED', 'order', order_id, {
        payment_method: 'cash',
        amount_cents:   amountCents,
        bill_reference: billReference,
      });

      console.log(`✅ [paymobController] Cash reference issued for order ${order_id}: ${billReference}`);

      return res.status(200).json({
        success:          true,
        payment_type:     'cash',
        bill_reference:   billReference,
        expires_at:       expiresAt,
        amount_cents:     amountCents,
      });
    }

    // ── 7. Card / Wallet: generate key and build URL ──────────────────
    const paymentKey = await generatePaymentKey(authToken, paymobOrder, amountCents, integrationId, billingData);

    // ── 8. Build redirect / iframe URL (card / wallet only) ─────────────
    let paymentUrl;
    if (method === 'wallet') {
      paymentUrl = `${PAYMOB_WALLET_BASE}/${paymentKey}`;
    } else {
      const iframeId = process.env.PAYMOB_IFRAME_ID;
      if (!iframeId) {
        return res.status(500).json({ success: false, message: 'PAYMOB_IFRAME_ID is not configured.' });
      }
      paymentUrl = `${PAYMOB_IFRAME_BASE}/${iframeId}?payment_token=${paymentKey}`;
    }

    // ── 9. Persist status & log ─────────────────────────────────────────
    await supabase
      .from('orders')
      .update({ payment_status: 'initiated', updated_at: new Date().toISOString() })
      .eq('id', order_id);

    await logActivity(userId, 'PAYMENT_INITIATED', 'order', order_id, {
      payment_method: method,
      amount_cents: amountCents,
    });

    console.log(`✅ [paymobController] Payment initiated for order ${order_id} (${method})`);

    return res.status(200).json({
      success:      true,
      payment_url:  paymentUrl,
      payment_key:  paymentKey,
      payment_type: method,
    });
  } catch (err) {
    // Safe error — never include internal secrets
    console.error('❌ [paymobController] initiatePayment error:', err.message);
    return res.status(500).json({ success: false, message: 'Payment initiation failed. Please try again.' });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Paymob HMAC fields — must be concatenated in this exact order (per Paymob docs)
// Source: https://docs.paymob.com/docs/hmac-calculation
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
  'order',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

// ── Helper: build HMAC string and compare ────────────────────────────────────
function verifyPaymobHmac(body, receivedHmac) {
  const secret = process.env.PAYMOB_HMAC_SECRET;
  if (!secret) {
    console.error('❌ [paymobController] PAYMOB_HMAC_SECRET is not set.');
    return false;
  }

  // Safely navigate nested source_data fields
  const get = (obj, key) => {
    if (key.startsWith('source_data.')) {
      const subKey = key.split('.')[1];
      return obj?.source_data?.[subKey] ?? '';
    }
    return obj?.[key] ?? '';
  };

  // Resolve the obj — Paymob nests transaction data under body.obj
  const obj = body?.obj ?? body;

  const concatenated = HMAC_FIELDS
    .map((field) => String(get(obj, field)))
    .join('');

  const expected = crypto
    .createHmac('sha512', secret)
    .update(concatenated)
    .digest('hex');

  // Timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(receivedHmac, 'hex')
    );
  } catch {
    return false; // Buffer lengths differ → invalid
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/payments/paymob/webhook
// Public endpoint — called by Paymob's servers after payment attempt.
//
// Paymob sends the raw JSON body with ?hmac=<hash> in the query string.
// We MUST return HTTP 200 in all cases so Paymob doesn't keep retrying.
// Business-logic failures (amount mismatch, duplicate, etc.) are logged
// but still acknowledged with 200 to prevent re-delivery storms.
// ══════════════════════════════════════════════════════════════════════════════
async function handleWebhook(req, res) {
  // ── 1. Parse raw body (express.raw() gives us a Buffer) ──────────────────
  let body;
  try {
    const rawBody = req.body; // Buffer from express.raw()
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    console.error('❌ [paymobWebhook] Could not parse request body as JSON.');
    return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
  }

  // ── 2. HMAC Validation ────────────────────────────────────────────────────
  const receivedHmac = req.query?.hmac;
  if (!receivedHmac) {
    console.warn('⚠️ [paymobWebhook] Missing hmac query parameter — rejected.');
    return res.status(400).json({ success: false, message: 'Missing HMAC.' });
  }

  if (!verifyPaymobHmac(body, receivedHmac)) {
    console.warn('🚨 [paymobWebhook] HMAC validation FAILED — possible spoofed request.');
    return res.status(400).json({ success: false, message: 'HMAC validation failed.' });
  }

  console.log('✅ [paymobWebhook] HMAC validated successfully.');

  // ── 3. Extract transaction data ───────────────────────────────────────────
  const txn = body?.obj ?? body;

  const paymobTransactionId = String(txn?.id ?? '');
  const isSuccess           = txn?.success === true;
  const isPending           = txn?.pending === true;
  const amountCentsReported = parseInt(txn?.amount_cents ?? '0', 10);
  // Paymob embeds our internal order ID in txn.order.merchant_order_id
  const internalOrderId     = txn?.order?.merchant_order_id ?? null;

  console.log(`📬 [paymobWebhook] txn=${paymobTransactionId} success=${isSuccess} pending=${isPending} orderId=${internalOrderId}`);

  // ── 4. Idempotency — reject already-processed transactions ───────────────
  if (paymobTransactionId) {
    const { data: existing } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq('paymob_transaction_id', paymobTransactionId)
      .maybeSingle();

    if (existing) {
      console.log(`ℹ️ [paymobWebhook] Transaction ${paymobTransactionId} already processed — skipping.`);
      return res.status(200).json({ success: true, message: 'Already processed.' });
    }
  }

  // ── 5. Resolve internal order ID ─────────────────────────────────────────
  if (!internalOrderId) {
    console.error('❌ [paymobWebhook] Cannot resolve internal order ID from webhook payload.');
    return res.status(200).json({ success: true, message: 'Acknowledged (unresolvable order).' });
  }

  // Fetch our order
  const { data: order, error: fetchErr } = await supabase
    .from('orders')
    .select('id, total, payment_status, user_id')
    .eq('id', internalOrderId)
    .maybeSingle();

  if (fetchErr || !order) {
    console.error(`❌ [paymobWebhook] Order ${internalOrderId} not found in DB.`);
    return res.status(200).json({ success: true, message: 'Acknowledged (order not found).' });
  }

  if (order.payment_status === 'paid') {
    console.log(`ℹ️ [paymobWebhook] Order ${internalOrderId} already marked paid — skipping.`);
    return res.status(200).json({ success: true, message: 'Already processed.' });
  }

  // ── 6. Amount verification ────────────────────────────────────────────────
  let expectedAmountCents;
  try {
    expectedAmountCents = await calcAmountCentsFromDB(internalOrderId);
  } catch (calcErr) {
    console.error(`❌ [paymobWebhook] Could not calculate expected amount: ${calcErr.message}`);
    // Fail the payment rather than silently continue with an unknown amount
    await supabase
      .from('orders')
      .update({ payment_status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', internalOrderId);

    await logActivity(null, 'PAYMENT_FAILED', 'order', internalOrderId, {
      reason: 'Could not recalculate expected amount from DB',
      paymob_transaction_id: paymobTransactionId,
    });
    return res.status(200).json({ success: true, message: 'Acknowledged (amount calculation error).' });
  }

  if (amountCentsReported !== expectedAmountCents) {
    console.error(
      `🚨 [paymobWebhook] Amount mismatch! reported=${amountCentsReported} expected=${expectedAmountCents} — FRAUD ALERT`
    );
    await supabase
      .from('orders')
      .update({
        payment_status:         'failed',
        paymob_transaction_id:  paymobTransactionId || null,
        updated_at:             new Date().toISOString(),
      })
      .eq('id', internalOrderId);

    await logActivity(null, 'PAYMENT_AMOUNT_MISMATCH', 'order', internalOrderId, {
      reported_amount_cents:  amountCentsReported,
      expected_amount_cents:  expectedAmountCents,
      paymob_transaction_id:  paymobTransactionId,
    });
    return res.status(200).json({ success: true, message: 'Acknowledged (amount mismatch).' });
  }

  // ── 7. Determine final payment status ─────────────────────────────────────
  // success === true AND pending === false → genuinely successful payment
  const finalStatus = (isSuccess && !isPending) ? 'paid' : 'failed';

  // ── 8. Update order in DB ─────────────────────────────────────────────────
  const { error: updateErr } = await supabase
    .from('orders')
    .update({
      payment_status:        finalStatus,
      paymob_transaction_id: paymobTransactionId || null,
      // Optionally promote order status to 'confirmed' on successful payment
      ...(finalStatus === 'paid' ? { status: 'confirmed' } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', internalOrderId);

  if (updateErr) {
    console.error(`❌ [paymobWebhook] DB update failed for order ${internalOrderId}: ${updateErr.message}`);
    // Still return 200 so Paymob doesn't retry endlessly (DB might be transient)
    return res.status(200).json({ success: true, message: 'Acknowledged (DB update failed).' });
  }

  // ── 9. Log activity ───────────────────────────────────────────────────────
  const logAction = finalStatus === 'paid' ? 'PAYMENT_CONFIRMED' : 'PAYMENT_FAILED';
  await logActivity(order.user_id, logAction, 'order', internalOrderId, {
    paymob_transaction_id: paymobTransactionId,
    amount_cents:          amountCentsReported,
    success:               isSuccess,
    pending:               isPending,
  });

  console.log(`✅ [paymobWebhook] Order ${internalOrderId} → payment_status='${finalStatus}'.`);
  return res.status(200).json({ success: true, message: `Payment ${finalStatus}.` });
}

module.exports = { initiatePayment, handleWebhook };
