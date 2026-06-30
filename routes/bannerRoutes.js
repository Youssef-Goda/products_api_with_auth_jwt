/**
 * bannerRoutes.js
 * Admin/Moderator can add or delete promotional banners.
 * Customers can view active banners.
 *
 * Register in server.js:
 *   const bannerRoutes = require('./routes/bannerRoutes');
 *   app.use('/api/banners', bannerRoutes);
 *
 * Supabase table (create if not exists):
 *   CREATE TABLE banners (
 *     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     image_url   TEXT NOT NULL,
 *     title       TEXT,
 *     subtitle    TEXT,
 *     is_active   BOOLEAN DEFAULT true,
 *     created_by  UUID REFERENCES users(id),
 *     created_at  TIMESTAMPTZ DEFAULT now()
 *   );
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── GET /api/banners — public, returns all active banners ─────────────────────
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('banners')
      .select('id, image_url, title, subtitle')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('❌ [Banners] GET error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/banners — admin/moderator only ─────────────────────────────────
router.post('/', authenticateToken, async (req, res) => {
  const role = req.user?.role?.toLowerCase();
  if (!['admin', 'moderator', 'owner'].includes(role)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  const { imageUrl, image_url, title = '', subtitle = '' } = req.body;
  const url = imageUrl || image_url;

  if (!url || url.trim() === '') {
    return res.status(400).json({ success: false, message: 'imageUrl is required' });
  }

  try {
    const { data, error } = await supabase
      .from('banners')
      .insert({
        image_url: url.trim(),
        title: title.trim() || null,
        subtitle: subtitle.trim() || null,
        is_active: true,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    console.log(`✅ [Banners] Banner created by ${req.user.email}`);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    console.error('❌ [Banners] POST error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/banners/:id — admin/moderator only ───────────────────────────
router.delete('/:id', authenticateToken, async (req, res) => {
  const role = req.user?.role?.toLowerCase();
  if (!['admin', 'moderator', 'owner'].includes(role)) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }

  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('banners')
      .delete()
      .eq('id', id);

    if (error) throw error;
    console.log(`🗑️ [Banners] Banner ${id} deleted by ${req.user.email}`);
    return res.json({ success: true, message: 'Banner deleted.' });
  } catch (err) {
    console.error('❌ [Banners] DELETE error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
