/**
 * paymobRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers Paymob payment routes under /api/v1/payments/paymob (set in server.js):
 *
 *   POST /initiate   — Customer-facing; requires JWT auth.
 *                      Body: { order_id, payment_method }
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

const { authenticateToken }            = require('../middlewares/authMiddleware');
const { initiatePayment, handleWebhook } = require('../controllers/paymobController');

// ══════════════════════════════════════════════════════════════════════════════
// POST /initiate
// Protected endpoint — customer must supply a valid JWT.
// ══════════════════════════════════════════════════════════════════════════════
router.post('/initiate', authenticateToken, initiatePayment);

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
