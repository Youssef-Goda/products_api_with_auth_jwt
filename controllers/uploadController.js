const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');

// ── Constants ─────────────────────────────────────────────────────────────────

const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const IMGBB_UPLOAD_URL = 'https://api.imgbb.com/1/upload';

// ── Multer — memory storage (no disk writes) ──────────────────────────────────

const fileFilter = (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG/PNG/WebP files are allowed.'));
    }
};

const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: MAX_SIZE_BYTES },
});

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * POST /api/products/upload  (also mounted at /api/uploads/image for compat.)
 * Accepts a single file under the field name "image".
 *
 * Flow:
 *   1. multer buffers the bytes in req.file.buffer
 *   2. We re-pack them into a FormData and POST directly to ImgBB
 *   3. We extract the clean direct URL (i.ibb.co/…) and return it
 *
 * Response (200):  { success: true, url: "https://i.ibb.co/…" }
 * Response (400):  { success: false, message: "…" }
 * Response (500):  { success: false, message: "…" }
 */
const uploadImage = (req, res) => {
    const uploadSingle = upload.single('image');

    uploadSingle(req, res, async (err) => {
        // ── Multer-level errors ──────────────────────────────────────────────
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({
                    success: false,
                    message: `File too large. Maximum allowed size is ${MAX_SIZE_BYTES / (1024 * 1024)} MB.`,
                });
            }
            return res.status(400).json({
                success: false,
                message: err.field ?? 'Only JPG/PNG/WebP files are allowed.',
            });
        }

        if (err) {
            console.error('❌ Upload middleware error:', err);
            return res.status(500).json({ success: false, message: 'File upload failed.' });
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file provided. Send the image under the field name "image".',
            });
        }

        // ── Forward to ImgBB ─────────────────────────────────────────────────
        const apiKey = process.env.IMGBB_API_KEY;
        if (!apiKey) {
            console.error('❌ IMGBB_API_KEY is not set in .env');
            return res.status(500).json({
                success: false,
                message: 'Server configuration error: ImgBB API key is missing.',
            });
        }

        try {
            const form = new FormData();
            form.append('image', req.file.buffer, {
                filename: req.file.originalname || 'upload.jpg',
                contentType: req.file.mimetype,
            });

            const imgbbRes = await axios.post(
                `${IMGBB_UPLOAD_URL}?key=${apiKey}`,
                form,
                { headers: form.getHeaders(), timeout: 30_000 }
            );

            // ImgBB returns: { data: { url, display_url, … }, success, status }
            const imgbbData = imgbbRes.data?.data;
            const url = imgbbData?.display_url ?? imgbbData?.url;

            if (!url) {
                console.error('❌ ImgBB response missing URL:', imgbbRes.data);
                return res.status(502).json({
                    success: false,
                    message: 'ImgBB did not return a valid URL.',
                });
            }

            console.log(`✅ Image uploaded to ImgBB: ${url}`);
            return res.status(200).json({ success: true, url });

        } catch (imgbbErr) {
            const status = imgbbErr.response?.status;
            const detail = imgbbErr.response?.data?.error?.message ?? imgbbErr.message;
            console.error(`❌ ImgBB error (${status}):`, detail);
            return res.status(502).json({
                success: false,
                message: `ImgBB upload failed: ${detail}`,
            });
        }
    });
};

module.exports = { uploadImage };
