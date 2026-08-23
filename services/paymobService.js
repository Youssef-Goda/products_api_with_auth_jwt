/**
 * paymobService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Encapsulates the three-step Paymob payment flow:
 *   Step 1 — Authenticate  → getAuthToken()
 *   Step 2 — Register Order → registerOrder()
 *   Step 3 — Payment Key   → generatePaymentKey()
 *
 * All network calls use axios with a 10 s timeout.
 * Errors are sanitised before logging — API keys / secrets are never printed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const axios = require('axios');

const PAYMOB_BASE_URL = 'https://accept.paymob.com/api';

// Paymob kiosk/cash channel type identifier
const KIOSK_SUBTYPE = 'AGGREGATOR';

/** Shared axios instance with sane defaults */
const paymobClient = axios.create({
  baseURL: PAYMOB_BASE_URL,
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — strips anything that looks like a secret from error text
// so we never accidentally leak credentials to logs.
// ─────────────────────────────────────────────────────────────────────────────
function sanitiseError(err) {
  const status = err?.response?.status;
  const data   = err?.response?.data;
  // Never log the raw config (it may contain the Authorization header / API key)
  return new Error(
    `[Paymob] HTTP ${status ?? 'network error'}: ${JSON.stringify(data) ?? err.message}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 1 — Authenticate
// POST /api/auth/tokens
// Returns a short-lived auth token (valid ~ 1 hour per Paymob docs).
// ══════════════════════════════════════════════════════════════════════════════
async function getAuthToken() {
  const apiKey = process.env.PAYMOB_API_KEY;
  if (!apiKey) throw new Error('[Paymob] PAYMOB_API_KEY is not set in environment.');

  try {
    const response = await paymobClient.post('/auth/tokens', { api_key: apiKey });
    const token = response.data?.token;
    if (!token) throw new Error('[Paymob] Auth response did not contain a token.');
    console.log('✅ [paymobService] Auth token obtained.');
    return token;
  } catch (err) {
    throw sanitiseError(err);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 2 — Register Order on Paymob
// POST /api/ecommerce/orders
// amount_cents: integer (e.g. 5000 = 50.00 EGP)
// Returns the Paymob order ID (numeric).
// ══════════════════════════════════════════════════════════════════════════════
async function registerOrder(authToken, amountCents, currency = 'EGP') {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('[Paymob] amountCents must be a positive integer.');
  }

  try {
    const response = await paymobClient.post('/ecommerce/orders', {
      auth_token:     authToken,
      delivery_needed: false,
      amount_cents:   amountCents,
      currency,
      items: [],          // items are tracked on our side; Paymob doesn't require them
    });

    const paymobOrderId = response.data?.id;
    if (!paymobOrderId) throw new Error('[Paymob] Order registration did not return an id.');
    console.log(`✅ [paymobService] Order registered on Paymob: id=${paymobOrderId}`);
    return paymobOrderId;
  } catch (err) {
    throw sanitiseError(err);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 3 — Generate Payment Key
// POST /api/acceptance/payment_keys
// Returns a payment_key string (valid 1 hour).
//
// billingData should conform to Paymob's required schema:
//   { first_name, last_name, email, phone_number, country, city,
//     street, building, floor, apartment, postal_code, state }
// ══════════════════════════════════════════════════════════════════════════════
async function generatePaymentKey(authToken, paymobOrderId, amountCents, integrationId, billingData = {}) {
  if (!integrationId) throw new Error('[Paymob] integrationId is required to generate a payment key.');

  // Paymob requires ALL billing fields; supply safe defaults for optional ones
  const billing = {
    apartment:    billingData.apartment   ?? 'N/A',
    email:        billingData.email       ?? 'customer@example.com',
    floor:        billingData.floor       ?? 'N/A',
    first_name:   billingData.first_name  ?? 'Customer',
    street:       billingData.street      ?? 'N/A',
    building:     billingData.building    ?? 'N/A',
    phone_number: billingData.phone_number ?? '+201000000000',
    shipping_method: 'N/A',
    postal_code:  billingData.postal_code ?? '00000',
    city:         billingData.city        ?? 'Cairo',
    country:      billingData.country     ?? 'EG',
    last_name:    billingData.last_name   ?? 'User',
    state:        billingData.state       ?? 'Cairo',
  };

  try {
    const response = await paymobClient.post('/acceptance/payment_keys', {
      auth_token:    authToken,
      amount_cents:  amountCents,
      expiration:    3600,          // 1 hour
      order_id:      paymobOrderId,
      billing_data:  billing,
      currency:      'EGP',
      integration_id: integrationId,
      lock_order_when_paid: true,
    });

    const paymentKey = response.data?.token;
    if (!paymentKey) throw new Error('[Paymob] Payment key response did not contain a token.');
    console.log('✅ [paymobService] Payment key generated.');
    return paymentKey;
  } catch (err) {
    throw sanitiseError(err);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Cash / Fawry (Kiosk) — Initiate Reference
// Calls POST /api/acceptance/payments/pay to obtain a bill_reference number.
// Unlike card/wallet, there is no iframe URL — Paymob returns a reference
// number the customer presents at any Fawry / Aman / Masary outlet.
//
// integrationId: PAYMOB_CASH_INTEGRATION_ID
// Returns: { billReference, expiresAt }
// ══════════════════════════════════════════════════════════════════════════════
async function generateCashReference(authToken, paymobOrderId, amountCents, billingData = {}) {
  const integrationId = process.env.PAYMOB_CASH_INTEGRATION_ID;
  if (!integrationId) {
    throw new Error('[Paymob] PAYMOB_CASH_INTEGRATION_ID is not set in environment.');
  }

  // Step 3a — generate payment key for cash integration
  const paymentKey = await generatePaymentKey(authToken, paymobOrderId, amountCents, integrationId, billingData);

  // Step 3b — execute the pay call to obtain the kiosk bill_reference
  try {
    const response = await paymobClient.post('/acceptance/payments/pay', {
      source: {
        identifier:  'AGGREGATOR',
        subtype:     KIOSK_SUBTYPE,
      },
      payment_token: paymentKey,
    });

    const billReference = response.data?.id?.toString()
      ?? response.data?.data?.bill_reference?.toString()
      ?? response.data?.bill_reference?.toString();

    if (!billReference) {
      console.warn('[Paymob] Cash pay response:', JSON.stringify(response.data));
      throw new Error('[Paymob] Cash reference not found in pay response.');
    }

    // Paymob kiosk references typically expire after 72 hours
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    console.log(`✅ [paymobService] Cash reference generated: ${billReference}`);
    return { billReference, expiresAt };
  } catch (err) {
    throw sanitiseError(err);
  }
}

module.exports = { getAuthToken, registerOrder, generatePaymentKey, generateCashReference };
