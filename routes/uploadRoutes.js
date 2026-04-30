const express = require('express');
const router = express.Router();
const { uploadImage } = require('../controllers/uploadController');
const { authenticateToken } = require('../middlewares/authMiddleware');

/**
 * POST /api/uploads/image
 * Protected — requires a valid JWT Bearer token.
 * Body: multipart/form-data with field "image" (JPG or PNG, max 5 MB)
 *
 * Success response:
 *   { success: true, url: "http://host/uploads/<filename>", filename, size }
 *
 * Error responses:
 *   401 — missing / invalid token
 *   400 — wrong file type, file too large, or no file provided
 *   500 — unexpected server error
 */
router.post('/image', authenticateToken, uploadImage);

module.exports = router;
