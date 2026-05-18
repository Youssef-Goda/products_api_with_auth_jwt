/**
 * addressRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CRUD for the `shipping_addresses` table. Uses the Supabase SERVICE ROLE key
 * so RLS does not block server-side operations.  Every route is protected by
 * the JWT `authenticateToken` middleware — req.user.id is the authenticated
 * user extracted from the Bearer token.
 *
 * Mount in server.js:
 *   const addressRoutes = require('./routes/addressRoutes');
 *   app.use('/api/addresses', addressRoutes);
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase admin client — bypasses RLS ─────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Never expose this to the client!
);

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/addresses  — List all addresses for the authenticated user
// ══════════════════════════════════════════════════════════════════════════════
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('shipping_addresses')
      .select('*')
      .eq('user_id', req.user.id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ [Addresses] GET / Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/addresses  — Create a new address
// Body: { full_name, phone, address_line1, address_line2?, city, governorate, is_default? }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/', authenticateToken, async (req, res) => {
  const {
    full_name,
    phone,
    address_line1,
    address_line2,
    city,
    governorate,
    is_default = false,
  } = req.body;

  // ── Basic validation ────────────────────────────────────────────────────
  if (!full_name || !phone || !address_line1 || !city || !governorate) {
    return res.status(400).json({
      success: false,
      message: 'full_name, phone, address_line1, city, and governorate are required.',
    });
  }

  try {
    // If this address is default, clear other defaults first
    if (is_default) {
      await supabase
        .from('shipping_addresses')
        .update({ is_default: false })
        .eq('user_id', req.user.id)
        .eq('is_default', true);
    }

    const { data, error } = await supabase
      .from('shipping_addresses')
      .insert({
        user_id: req.user.id,
        full_name,
        phone,
        address_line1,
        address_line2: address_line2 || null,
        city,
        governorate,
        is_default,
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ [Addresses] Created address ${data.id} for user ${req.user.id}`);
    return res.status(201).json({ success: true, data });
  } catch (err) {
    console.error('❌ [Addresses] POST / Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PUT /api/addresses/:id  — Update an existing address (must belong to user)
// ══════════════════════════════════════════════════════════════════════════════
router.put('/:id', authenticateToken, async (req, res) => {
  const {
    full_name,
    phone,
    address_line1,
    address_line2,
    city,
    governorate,
    is_default,
  } = req.body;

  try {
    // Verify ownership before updating
    const { data: existing, error: fetchError } = await supabase
      .from('shipping_addresses')
      .select('id, user_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Address not found.' });
    }
    if (existing.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    // If setting as default, clear other defaults
    if (is_default) {
      await supabase
        .from('shipping_addresses')
        .update({ is_default: false })
        .eq('user_id', req.user.id)
        .eq('is_default', true)
        .neq('id', req.params.id);
    }

    const updates = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;
    if (address_line1 !== undefined) updates.address_line1 = address_line1;
    if (address_line2 !== undefined) updates.address_line2 = address_line2 || null;
    if (city !== undefined) updates.city = city;
    if (governorate !== undefined) updates.governorate = governorate;
    if (is_default !== undefined) updates.is_default = is_default;

    const { data, error } = await supabase
      .from('shipping_addresses')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ [Addresses] Updated address ${req.params.id} for user ${req.user.id}`);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ [Addresses] PUT /:id Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DELETE /api/addresses/:id  — Delete an address (must belong to user)
// ══════════════════════════════════════════════════════════════════════════════
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from('shipping_addresses')
      .select('id, user_id')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Address not found.' });
    }
    if (existing.user_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    const { error } = await supabase
      .from('shipping_addresses')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    console.log(`✅ [Addresses] Deleted address ${req.params.id} for user ${req.user.id}`);
    return res.json({ success: true, message: 'Address deleted successfully.' });
  } catch (err) {
    console.error('❌ [Addresses] DELETE /:id Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
