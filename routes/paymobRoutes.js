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

const { authenticateToken }              = require('../middlewares/authMiddleware');
const { initiatePayment, handleWebhook } = require('../controllers/paymobController');

// ── Inline CORS headers (belt-and-suspenders) ────────────────────────────────
// The global cors() middleware in server.js already handles this, but because
// this router is mounted BEFORE express.json() (required for HMAC), we add
// explicit headers here as well to guarantee no preflight is ever blocked.
function setCorsHeaders(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
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

