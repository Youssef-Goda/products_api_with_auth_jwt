const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

// ── GET /api/v1/settings/public — Public endpoint for feature flags ────────
router.get('/public', settingsController.getPublicSettings);

module.exports = router;
