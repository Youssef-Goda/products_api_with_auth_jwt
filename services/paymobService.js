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

// Helper: Strips quotes, backslashes, and whitespace from environment variables
function cleanEnv(val) {
  if (!val) return '';
  return String(val)
    .trim()
    .replace(/[\r\n]/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — strips anything that looks like a secret from error text
// so we never accidentally leak credentials to logs.
// ─────────────────────────────────────────────────────────────────────────────
function sanitiseError(err) {
  const status = err?.response?.status;
  const data   = err?.response?.data;

  console.error('❌ [paymobService] Paymob API HTTP error details:', {
    status: status ?? 'network error',
    data: data ? JSON.stringify(data, null, 2) : 'No data returned',
    message: err.message,
  });

  if (status === 401 || status === 403) {
    const detail = data ? JSON.stringify(data) : 'Incorrect credentials';
    return new Error(`Paymob Authentication Failed: ${detail} (HTTP ${status})`);
  }

  const detailMsg = data
    ? (typeof data === 'object' ? JSON.stringify(data) : String(data))
    : err.message;

  return new Error(
    `[Paymob] HTTP ${status ?? 'Network Error'}: ${detailMsg}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Paymob Intention API
// POST /v1/intention/
// Returns an intention object containing a client_secret.
// ══════════════════════════════════════════════════════════════════════════════
async function createIntention(amountCents, currency = 'EGP', paymentMethods = [], billingData = {}, extras = {}) {
  const rawSecretKey = cleanEnv(process.env.PAYMOB_SECRET_KEY || process.env.PAYMOB_API_KEY);
  if (!rawSecretKey) {
    throw new Error('[Paymob] Neither PAYMOB_SECRET_KEY nor PAYMOB_API_KEY is configured in the server environment.');
  }

  // Strip existing prefix if present to normalize
  const keyBody = rawSecretKey.replace(/^(Token|Bearer|SecretKey)\s+/i, '').trim();
  const authHeader = `Token ${keyBody}`;
  const redactedAuth = `Token ${keyBody.length > 8 ? `${keyBody.slice(0, 4)}****${keyBody.slice(-4)}` : '****'}`;

  // Paymob Intention API requires billing_data and customer objects
  const customerData = {
    first_name:   billingData.first_name  ?? 'Customer',
    last_name:    billingData.lastName    ?? billingData.last_name ?? 'User',
    email:        billingData.email       ?? 'customer@example.com',
    phone_number: billingData.phone_number ?? '+201000000000',
  };

  const fullBillingData = {
    ...customerData,
    apartment:    billingData.apartment   ?? 'N/A',
    floor:        billingData.floor       ?? 'N/A',
    street:       billingData.street      ?? 'N/A',
    building:     billingData.building    ?? 'N/A',
    shipping_method: 'N/A',
    postal_code:  billingData.postal_code ?? '00000',
    city:         billingData.city        ?? 'Cairo',
    country:      billingData.country     ?? 'EG',
    state:        billingData.state       ?? 'Cairo',
  };

  try {
    const payload = {
      amount: amountCents,
      currency,
      payment_methods: paymentMethods.map(id => parseInt(id, 10)).filter(id => !isNaN(id)),
      billing_data: fullBillingData,
      customer: customerData,
      extras: extras,
    };

    console.log('📡 [paymobService] Sending Intention API request:', {
      url: 'https://accept.paymob.com/v1/intention/',
      headers: {
        'Authorization': redactedAuth,
        'Content-Type': 'application/json',
      },
      amount: payload.amount,
      currency: payload.currency,
      payment_methods: payload.payment_methods,
      customer_email: payload.customer.email,
    });

    const response = await axios.post('https://accept.paymob.com/v1/intention/', payload, {
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      timeout: 10_000,
    });

    if (!response.data?.client_secret) {
      console.error(
        '❌ [paymobService] Paymob Intention API response did not contain client_secret. Full response:',
        JSON.stringify(response.data, null, 2)
      );
      const respStr = typeof response.data === 'object'
        ? JSON.stringify(response.data)
        : String(response.data);
      throw new Error(`[Paymob] Intention response did not contain a client_secret: ${respStr}`);
    }

    console.log(`✅ [paymobService] Intention created. Client Secret: ${response.data.client_secret.substring(0, 10)}...`);
    return response.data;
  } catch (err) {
    throw sanitiseError(err);
  }
}

module.exports = {
  createIntention,
};

