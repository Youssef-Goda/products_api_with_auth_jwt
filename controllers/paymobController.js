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
const {
  getAuthToken,
  registerOrder,
  generatePaymentKey,
  generateCashReference,
  generateWalletRedirectUrl,
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
    // Pass order_id as merchantOrderId — Paymob will echo it back as
    // txn.order.merchant_order_id in the HMAC-verified server-to-server webhook,
    // which is the ONLY mechanism handleWebhook uses to resolve the local order.
    const paymobOrder = await registerOrder(authToken, amountCents, order_id);

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

    // ── 5b. Mobile Wallet (UIG) ──────────────────────────────────────────────
    if (method === 'wallet') {
      const rawWalletNum = String(req.body?.wallet_number || req.body?.phone_number || '').trim();

      if (!isValidEgyptianMobile(rawWalletNum)) {
        return res.status(400).json({
          success: false,
          message: 'A valid Egyptian mobile wallet phone number (e.g., 01012345678) is required for mobile wallet payments.',
        });
      }

      const walletResult = await generateWalletRedirectUrl(
        authToken,
        paymobOrder,
        amountCents,
        billingData,
        rawWalletNum
      );

      await supabase
        .from('orders')
        .update({ payment_status: 'initiated', updated_at: new Date().toISOString() })
        .eq('id', order_id);

      await logActivity(userId, 'PAYMENT_INITIATED', 'order', order_id, {
        payment_method: 'wallet',
        amount_cents:   amountCents,
      });

      console.log(`✅ [paymobController] Wallet payment initiated for order ${order_id}`);

      return res.status(200).json({
        success:      true,
        payment_type: 'wallet',
        // payment_url is the canonical field Flutter reads to open the authorization page.
        // iframe_url kept for backward compatibility with any older client versions.
        payment_url:  walletResult.redirectUrl,
        iframe_url:   walletResult.redirectUrl,
        pending:      walletResult.pending,
      });
    }

    // ── 5c. Credit / Debit Card (VPC) ─────────────────────────────────────────
    const paymentKey = await generatePaymentKey(
      authToken, paymobOrder, amountCents, integrationId, billingData
    );

    const iframeId = cleanEnv(process.env.PAYMOB_IFRAME_ID);
    if (!iframeId) {
      return res.status(500).json({
        success: false,
        message: 'Payment initialization failed: PAYMOB_IFRAME_ID is not configured.',
      });
    }
    const iframeUrl = `${PAYMOB_IFRAME_BASE}/${iframeId}?payment_token=${paymentKey}`;

    await supabase
      .from('orders')
      .update({ payment_status: 'initiated', updated_at: new Date().toISOString() })
      .eq('id', order_id);

    await logActivity(userId, 'PAYMENT_INITIATED', 'order', order_id, {
      payment_method: 'card',
      amount_cents:   amountCents,
    });

    console.log(`✅ [paymobController] Card payment initiated for order ${order_id}`);

    return res.status(200).json({
      success:      true,
      payment_type: 'card',
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
  const secret = cleanEnv(process.env.PAYMOB_HMAC_SECRET);
  if (!secret) {
    throw new Error('PAYMOB_HMAC_SECRET is not set');
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
    // Secret not configured — server misconfiguration, log loudly
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
  const internalOrderId     = txn?.order?.merchant_order_id ?? null;

  console.log(`📬 [paymobWebhook] txn=${paymobTransactionId} success=${isSuccess} pending=${isPending} orderId=${internalOrderId}`);

  // ── 4. Idempotency guard (by Paymob transaction ID) ─────────────────────────
  // If we have already processed this exact transaction, skip everything.
  // This prevents double-emails and double-cart-clears on Paymob retries.
  if (paymobTransactionId) {
    const { data: existing } = await supabase
      .from('orders')
      .select('id, payment_status')
      .eq('paymob_transaction_id', paymobTransactionId)
      .maybeSingle();

    if (existing) {
      console.log(`ℹ️ [paymobWebhook] Transaction ${paymobTransactionId} already processed — skipping.`);
      return res.status(200).json({ received: true, message: 'Already processed.' });
    }
  }

  // ── 5. Resolve internal order ────────────────────────────────────────────────
  if (!internalOrderId) {
    console.error('❌ [paymobWebhook] Cannot resolve internal order ID from webhook payload.');
    return res.status(200).json({ received: true, message: 'Acknowledged (unresolvable order).' });
  }

  const { data: order, error: fetchErr } = await supabase
    .from('orders')
    .select('id, total, payment_status, user_id')
    .eq('id', internalOrderId)
    .maybeSingle();

  if (fetchErr || !order) {
    console.error(`❌ [paymobWebhook] Order ${internalOrderId} not found in DB.`);
    return res.status(200).json({ received: true, message: 'Acknowledged (order not found).' });
  }

  // ── 4b. Idempotency guard (by order payment_status) ─────────────────────────
  // Belt-and-suspenders: if the order is already marked paid (e.g. the txn ID
  // column was null last time), do NOT re-send emails or re-clear carts.
  if (order.payment_status === 'paid') {
    console.log(`ℹ️ [paymobWebhook] Order ${internalOrderId} already marked paid — skipping.`);
    return res.status(200).json({ received: true, message: 'Already processed.' });
  }

  // ── 6. Amount verification ───────────────────────────────────────────────────
  // Re-calculate from DB — never trust the amount Paymob reports.
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
    return res.status(200).json({ received: true, message: 'Acknowledged (amount calculation error).' });
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
    return res.status(200).json({ received: true, message: 'Acknowledged (amount mismatch).' });
  }

  // ── 7. Determine final status and update order ───────────────────────────────
  // ★ THIS IS THE ONLY PLACE IN THE ENTIRE CODEBASE THAT SETS payment_status='paid'.
  //   handleCallback performs ZERO database writes.
  //   initiatePayment only sets 'initiated'.
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
  }

  // ── 8. On successful payment: clear cart & send confirmation email ────────
  if (finalStatus === 'paid') {
    // 8a. Clear user's server-side cart
    try {
      const { error: cartErr } = await supabase
        .from('cart_items')
        .delete()
        .eq('user_id', order.user_id);
      if (cartErr) {
        console.warn(`⚠️ [paymobWebhook] Cart clear failed for user ${order.user_id}: ${cartErr.message}`);
      } else {
        console.log(`🛒 [paymobWebhook] Cart cleared for user ${order.user_id}`);
      }
    } catch (cartExc) {
      console.warn('⚠️ [paymobWebhook] Cart clear exception:', cartExc.message);
    }

    // 8b. Fetch full order and user data to send confirmation email
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
          .then(() => console.log(`📧 [paymobWebhook] Confirmation email sent to ${userRow.email}`))
          .catch(e => console.warn('⚠️ [paymobWebhook] Order email skipped:', e.message));
      }
    } catch (emailErr) {
      console.warn('⚠️ [paymobWebhook] Could not send confirmation email:', emailErr.message);
    }
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
  return res.status(200).json({ received: true, message: `Payment ${finalStatus}.` });

  } catch (outerErr) {
    // Safety net: any uncaught async error must NOT bubble up as a 500.
    // Paymob retries on non-200 responses — a 500 would cause an infinite storm.
    // Log the full stack for manual investigation and acknowledge the request.
    console.error('🚨 [paymobWebhook] Unhandled exception in webhook handler:', outerErr?.message, outerErr?.stack);
    return res.status(200).json({ received: false, message: 'Internal error — logged for investigation.' });
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
function handleCallback(req, res) {
  const {
    success           = 'false',
    pending           = 'false',
    id:       txnId   = '',
    merchant_order_id = '',
    order:    paymobOrder = '',
    txn_response_code = '',
  } = req.query;

  console.log(
    `📲 [paymobCallback] Received — success=${success} pending=${pending} ` +
    `orderId=${merchant_order_id} txnId=${txnId}`
  );

  // ── Resolve the frontend base URL — never hardcode a port ─────────────────
  // Note: FRONTEND_URL must be set per-environment (Vercel prod vs local .env).
  // In local development, the frontend port may vary, so we allow dynamic fallbacks.
  let frontendBase = '';
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    // Local dev: prefer explicit LOCAL_FRONTEND_URL or dynamic Referer/Origin
    frontendBase = cleanEnv(process.env.LOCAL_FRONTEND_URL);
    if (!frontendBase) {
      const referer = req.get('Referer') || req.get('Origin') || '';
      if (referer) {
        try { frontendBase = new URL(referer).origin; } catch { /* ignore */ }
      }
    }
  }

  // Fallback to FRONTEND_URL (primary for production, fallback for local dev)
  if (!frontendBase) {
    frontendBase = cleanEnv(process.env.FRONTEND_URL);
  }

  if (!frontendBase) {
    console.warn('⚠️ [paymobCallback] FRONTEND_URL not set, no Referer — returning params as JSON');
    return res.status(200).json({
      success, pending,
      order_id: merchant_order_id,
      txn_id:   txnId,
      code:     txn_response_code,
      message:  'Set FRONTEND_URL env var to enable automatic browser redirect.',
    });
  }

  // Strip any trailing path/fragment → clean origin
  try { frontendBase = new URL(frontendBase).origin; }
  catch { frontendBase = frontendBase.split('#')[0].replace(/\/+$/, ''); }

  const params = new URLSearchParams({
    success,
    pending,
    order_id: merchant_order_id,
    txn_id:   txnId,
    code:     txn_response_code,
  });

  // ── Build the Flutter deep-link URL ──────────────────────────────────────
  // Flutter web uses usePathUrlStrategy() (no hash routing), so the redirect
  // must be a plain path URL — NOT a hash URL like /#/checkout/status.
  // Hash URLs with path strategy result in Flutter seeing path='/' and routing
  // to HomeScreen instead of CheckoutStatusScreen.
  const redirectUrl = `${frontendBase}/checkout/status?${params.toString()}`;

  console.log(`↩️ [paymobCallback] Redirecting browser → ${redirectUrl}`);
  return res.redirect(302, redirectUrl);
}

module.exports = { initiatePayment, handleWebhook, handleCallback };
