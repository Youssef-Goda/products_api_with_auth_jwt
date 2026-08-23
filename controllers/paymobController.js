/**
 * paymobController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles the two Paymob payment endpoints:
 *
 *   initiatePayment  POST /api/v1/payments/paymob/initiate   (protected — customer JWT)
 *   handleWebhook    POST /api/v1/payments/paymob/webhook    (public — Paymob server)
 *
 * Architecture notes (transactional safety):
 *  • Order is created first by the /api/orders endpoint with payment_status='pending'.
 *  • initiatePayment ONLY generates a Paymob session — it does NOT confirm the order.
 *  • Order is only marked 'confirmed' by the webhook after Paymob verifies payment.
 *  • If the Paymob API call fails, we return 502 with the exact reason — the order
 *    stays in 'pending' state so the customer can retry without data loss.
 *  • Amount is ALWAYS re-read from DB — client-sent amounts are never trusted.
 *  • Webhook HMAC is validated (crypto.timingSafeEqual) before any logic runs.
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

// Helper: Strips quotes and whitespace from environment variables
function cleanEnv(val) {
  if (!val) return '';
  return String(val).trim().replace(/^["']|["']$/g, '');
}

// ── Paymob URL bases ──────────────────────────────────────────────────────────
const PAYMOB_IFRAME_BASE  = 'https://accept.paymob.com/api/acceptance/iframes';
const PAYMOB_WALLET_BASE  = 'https://accept.paymob.com/api/acceptance/pay';

// ══════════════════════════════════════════════════════════════════════════════
// Helper — calculate order amount in piastres from order_items in DB.
// This is the single source of truth — the client-sent amount is ignored.
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

  return Math.round(totalEGP * 100);
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

    const method = (payment_method || 'card').toLowerCase();
    if (!['card', 'wallet', 'cash', 'fawry'].includes(method)) {
      return res.status(400).json({
        success: false,
        message: "payment_method must be 'card', 'wallet', or 'cash'.",
      });
    }

    const isCash = method === 'cash' || method === 'fawry';

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

    // ── 3. Calculate amount strictly from DB ──────────────────────────────────
    let amountCents;
    try {
      amountCents = await calcAmountCentsFromDB(order_id);
      console.log(`💰 [paymobController] Order ${order_id} → amountCents=${amountCents}`);
    } catch (calcErr) {
      return res.status(500).json({
        success: false,
        message: `Payment initialization failed: could not calculate order amount — ${calcErr.message}`,
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

    // ── 5. Call Paymob APIs ──────────────────────────────────────────────────
    const authToken   = await getAuthToken();
    const paymobOrder = await registerOrder(authToken, amountCents);

    // ── 5a. Cash / Fawry kiosk ───────────────────────────────────────────────
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
        reference_number: billReference,
        expire_date:      expiresAt,
        amount_cents:     amountCents,
      });
    }

    // ── 5b. Card / Wallet ────────────────────────────────────────────────────
    const paymentKey = await generatePaymentKey(
      authToken, paymobOrder, amountCents, integrationId, billingData
    );

    let iframeUrl;
    if (method === 'wallet') {
      iframeUrl = `${PAYMOB_WALLET_BASE}/${paymentKey}`;
    } else {
      const iframeId = cleanEnv(process.env.PAYMOB_IFRAME_ID);
      if (!iframeId) {
        return res.status(500).json({
          success: false,
          message: 'Payment initialization failed: PAYMOB_IFRAME_ID is not configured.',
        });
      }
      iframeUrl = `${PAYMOB_IFRAME_BASE}/${iframeId}?payment_token=${paymentKey}`;
    }

    await supabase
      .from('orders')
      .update({ payment_status: 'initiated', updated_at: new Date().toISOString() })
      .eq('id', order_id);

    await logActivity(userId, 'PAYMENT_INITIATED', 'order', order_id, {
      payment_method: method,
      amount_cents:   amountCents,
    });

    console.log(`✅ [paymobController] Payment initiated for order ${order_id} (${method})`);

    return res.status(200).json({
      success:      true,
      payment_type: method,
      iframe_url:   iframeUrl,
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
        message: 'Paymob Authentication Failed: Incorrect credentials.',
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
  'order',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
];

function verifyPaymobHmac(body, receivedHmac) {
  const secret = process.env.PAYMOB_HMAC_SECRET;
  if (!secret) {
    console.error('❌ [paymobController] PAYMOB_HMAC_SECRET is not set.');
    return false;
  }

  const get = (obj, key) => {
    if (key.startsWith('source_data.')) {
      const subKey = key.split('.')[1];
      return obj?.source_data?.[subKey] ?? '';
    }
    return obj?.[key] ?? '';
  };

  const obj = body?.obj ?? body;
  const concatenated = HMAC_FIELDS.map((field) => String(get(obj, field))).join('');

  const expected = crypto
    .createHmac('sha512', secret)
    .update(concatenated)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(receivedHmac, 'hex')
    );
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/payments/paymob/webhook
// Public — called by Paymob after payment attempt.
// Always returns 200 to prevent Paymob retry storms; business errors are logged.
// Order is ONLY confirmed here — never in initiatePayment.
// ══════════════════════════════════════════════════════════════════════════════
async function handleWebhook(req, res) {
  // ── 1. Parse raw body ─────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    console.error('❌ [paymobWebhook] Could not parse request body as JSON.');
    return res.status(400).json({ success: false, message: 'Invalid JSON body.' });
  }

  // ── 2. HMAC validation ────────────────────────────────────────────────────
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
  const internalOrderId     = txn?.order?.merchant_order_id ?? null;

  console.log(`📬 [paymobWebhook] txn=${paymobTransactionId} success=${isSuccess} pending=${isPending} orderId=${internalOrderId}`);

  // ── 4. Idempotency ────────────────────────────────────────────────────────
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

  // ── 5. Resolve internal order ─────────────────────────────────────────────
  if (!internalOrderId) {
    console.error('❌ [paymobWebhook] Cannot resolve internal order ID from webhook payload.');
    return res.status(200).json({ success: true, message: 'Acknowledged (unresolvable order).' });
  }

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
    return res.status(200).json({ success: true, message: 'Acknowledged (amount mismatch).' });
  }

  // ── 7. Determine final status and update order ────────────────────────────
  // Order is ONLY confirmed here — this is the authoritative confirmation point.
  const finalStatus = (isSuccess && !isPending) ? 'paid' : 'failed';

  const { error: updateErr } = await supabase
    .from('orders')
    .update({
      payment_status:        finalStatus,
      paymob_transaction_id: paymobTransactionId || null,
      // Confirm the order only on successful payment
      ...(finalStatus === 'paid' ? { status: 'confirmed' } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', internalOrderId);

  if (updateErr) {
    console.error(`❌ [paymobWebhook] DB update failed for order ${internalOrderId}: ${updateErr.message}`);
    return res.status(200).json({ success: true, message: 'Acknowledged (DB update failed).' });
  }

  // ── 8. Log activity ───────────────────────────────────────────────────────
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
