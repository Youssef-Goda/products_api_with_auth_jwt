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

// Helper: Strips quotes and whitespace from environment variables
function cleanEnv(val) {
  if (!val) return '';
  return String(val).trim().replace(/^["']|["']$/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — strips anything that looks like a secret from error text
// so we never accidentally leak credentials to logs.
// ─────────────────────────────────────────────────────────────────────────────
function sanitiseError(err) {
  const status = err?.response?.status;
  const data   = err?.response?.data;

  if (status === 401 || status === 403) {
    return new Error(`Paymob Authentication Failed: Incorrect credentials. (HTTP ${status})`);
  }

  return new Error(
    `[Paymob] HTTP ${status ?? 'network error'}: ${data ? JSON.stringify(data) : err.message}`
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Step 1 — Authenticate
// POST /api/auth/tokens
// Returns a short-lived auth token (valid ~ 1 hour per Paymob docs).
// ══════════════════════════════════════════════════════════════════════════════
async function getAuthToken() {
  const apiKey = cleanEnv(process.env.PAYMOB_API_KEY);
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
// amount_cents:      integer (e.g. 5000 = 50.00 EGP)
// merchantOrderId:   our internal order UUID — sent as merchant_order_id so
//                    Paymob echoes it back in the webhook as
//                    txn.order.merchant_order_id, allowing us to correlate
//                    the payment back to the correct local order.
// Returns the Paymob order ID (numeric).
// ══════════════════════════════════════════════════════════════════════════════
async function registerOrder(authToken, amountCents, merchantOrderId, currency = 'EGP') {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error('[Paymob] amountCents must be a positive integer.');
  }
  if (!merchantOrderId) {
    throw new Error('[Paymob] merchantOrderId (internal order UUID) is required.');
  }

  try {
    const response = await paymobClient.post('/ecommerce/orders', {
      auth_token:        authToken,
      delivery_needed:   false,
      amount_cents:      amountCents,
      currency,
      merchant_order_id: String(merchantOrderId),   // ← correlates webhook → local order
      items: [],          // items are tracked on our side; Paymob doesn't require them
    });

    const paymobOrderId = response.data?.id;
    if (!paymobOrderId) throw new Error('[Paymob] Order registration did not return an id.');
    console.log(`✅ [paymobService] Order registered on Paymob: id=${paymobOrderId} merchant_order_id=${merchantOrderId}`);
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
  const cleanIntegrationId = cleanEnv(integrationId);
  if (!cleanIntegrationId) throw new Error('[Paymob] integrationId is required to generate a payment key.');

  const intId = parseInt(cleanIntegrationId, 10);
  const parsedIntegrationId = isNaN(intId) ? cleanIntegrationId : intId;

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
    // redirect_url: where Paymob sends the browser after card payment (should be the
    //   frontend checkout-result page, NOT the backend URL).
    // notification_url: server-to-server webhook endpoint on this backend.
    const redirectUrl      = cleanEnv(process.env.PAYMOB_REDIRECT_URL)      || '';
    const notificationUrl  = cleanEnv(process.env.PAYMOB_NOTIFICATION_URL)  || '';

    const response = await paymobClient.post('/acceptance/payment_keys', {
      auth_token:    authToken,
      amount_cents:  amountCents,
      expiration:    3600,          // 1 hour
      order_id:      paymobOrderId,
      billing_data:  billing,
      currency:      'EGP',
      integration_id: parsedIntegrationId,
      lock_order_when_paid: true,
      ...(redirectUrl     ? { redirect_url:     redirectUrl }     : {}),
      ...(notificationUrl ? { notification_url: notificationUrl } : {}),
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
  const integrationId = cleanEnv(process.env.PAYMOB_CASH_INTEGRATION_ID);
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

// ══════════════════════════════════════════════════════════════════════════════
// Mobile Wallet (UIG) — Initiate Wallet Pay
// Calls POST /api/acceptance/payments/pay with subtype: 'WALLET'.
// Paymob returns a redirect_url or iframe_redirection_url for wallet authorization.
//
// integrationId: PAYMOB_WALLET_INTEGRATION_ID
// Returns: { redirectUrl, pending, rawData }
// ══════════════════════════════════════════════════════════════════════════════
async function generateWalletRedirectUrl(authToken, paymobOrderId, amountCents, billingData = {}, walletNumber = '') {
  const integrationId = cleanEnv(process.env.PAYMOB_WALLET_INTEGRATION_ID);
  if (!integrationId) {
    throw new Error('[Paymob] PAYMOB_WALLET_INTEGRATION_ID is not set in environment.');
  }

  // Step 3a — generate payment key for wallet integration
  const paymentKey = await generatePaymentKey(authToken, paymobOrderId, amountCents, integrationId, billingData);

  // Determine wallet identifier (customer phone number)
  const identifier = walletNumber || billingData.phone_number || 'WALLET';

  // Step 3b — execute the pay call to obtain the wallet redirect URL
  try {
    const response = await paymobClient.post('/acceptance/payments/pay', {
      source: {
        identifier: identifier,
        subtype:    'WALLET',
      },
      payment_token: paymentKey,
    });

    const data = response.data;

    // ── Log Paymob response fields for debugging (no secrets) ──────────────────
    console.log('[paymobService] Wallet pay response fields:', {
      has_iframe_redirection_url: !!data?.iframe_redirection_url,
      has_redirect_url:           !!data?.redirect_url,
      has_url:                    !!data?.url,
      pending:                    data?.pending,
      iframe_redirection_url:     data?.iframe_redirection_url ?? null,
      redirect_url:               data?.redirect_url ?? null,
    });

    // ── Strict Paymob URL validation ──────────────────────────────────────────
    // The merchant callback (PAYMOB_REDIRECT_URL) must NEVER be returned as the
    // wallet authorization URL. Valid Paymob payment pages are always hosted on
    // https://accept.paymob.com/.
    const PAYMOB_HOST       = 'https://accept.paymob.com/';
    const merchantCallback  = cleanEnv(process.env.PAYMOB_REDIRECT_URL);

    function isValidPaymobUrl(url) {
      return typeof url === 'string' && url.startsWith(PAYMOB_HOST);
    }

    function isMerchantCallback(url) {
      if (!url || !merchantCallback) return false;
      return url === merchantCallback || url.startsWith(merchantCallback.replace(/\/$/, ''));
    }

    // Priority: iframe_redirection_url > redirect_url > url — but only Paymob-hosted URLs.
    let redirectUrl = null;

    if (isValidPaymobUrl(data?.iframe_redirection_url)) {
      redirectUrl = data.iframe_redirection_url;
      console.log('[paymobService] Wallet: using iframe_redirection_url (Paymob-hosted).');
    } else if (isValidPaymobUrl(data?.redirect_url)) {
      redirectUrl = data.redirect_url;
      console.log('[paymobService] Wallet: using redirect_url (Paymob-hosted).');
    } else if (isValidPaymobUrl(data?.url)) {
      redirectUrl = data.url;
      console.log('[paymobService] Wallet: using url (Paymob-hosted).');
    } else {
      // None of the URL fields are Paymob-hosted — diagnose and reject.
      const hasMerchantCb = isMerchantCallback(data?.iframe_redirection_url)
        || isMerchantCallback(data?.redirect_url)
        || isMerchantCallback(data?.url);

      if (hasMerchantCb) {
        console.error(
          '[paymobService] Wallet pay returned merchant callback instead of Paymob auth URL. ' +
          'This usually means the wallet phone number (identifier) is invalid or Paymob ' +
          'could not generate a wallet session. ' +
          `identifier=${identifier}`
        );
        throw new Error(
          '[Paymob] Wallet authorization URL is the merchant callback, not a Paymob payment page. ' +
          'Ensure the wallet phone number is a valid registered mobile wallet number.'
        );
      }

      if (!data?.pending) {
        console.warn('[Paymob] Wallet pay response (no valid Paymob URL):', JSON.stringify(data));
        throw new Error('[Paymob] Wallet redirect URL was not returned in pay response.');
      }

      // pending=true with no URL is valid for async wallet flows
      console.log('[paymobService] Wallet: pending=true, no authorization URL (async flow).');
    }

    console.log(`✅ [paymobService] Wallet redirect URL generated for order ${paymobOrderId}`);
    return {
      redirectUrl: redirectUrl || null,
      pending:     data?.pending === true,
      rawData:     data,
    };
  } catch (err) {
    throw sanitiseError(err);
  }
}

module.exports = {
  getAuthToken,
  registerOrder,
  generatePaymentKey,
  generateCashReference,
  generateWalletRedirectUrl,
};

