/**
 * addressRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * CRUD for the `shipping_addresses` table, protected by JWT auth middleware.
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ROOT-CAUSE NOTE — Foreign Key Architecture                      ║
 * ║                                                                  ║
 * ║  This backend uses TWO separate user-identity systems:           ║
 * ║  1. Sequelize `public.users` table  → ID in the JWT (req.user.id)║
 * ║  2. Supabase `auth.users` table     → Supabase OAuth session UID ║
 * ║                                                                  ║
 * ║  shipping_addresses.user_id MUST reference public.users.id       ║
 * ║  (the same UUID the JWT carries), NOT auth.users.                ║
 * ║                                                                  ║
 * ║  Run this once in the Supabase SQL editor if you haven't yet:    ║
 * ║                                                                  ║
 * ║  -- Drop the old FK if it points to auth.users                   ║
 * ║  ALTER TABLE shipping_addresses                                  ║
 * ║    DROP CONSTRAINT IF EXISTS shipping_addresses_user_id_fkey;    ║
 * ║                                                                  ║
 * ║  -- Re-create pointing to public.users                           ║
 * ║  ALTER TABLE shipping_addresses                                  ║
 * ║    ADD CONSTRAINT shipping_addresses_user_id_fkey                ║
 * ║    FOREIGN KEY (user_id)                                         ║
 * ║    REFERENCES public.users(id)                                   ║
 * ║    ON DELETE CASCADE;                                            ║
 * ╚══════════════════════════════════════════════════════════════════╝
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
  process.env.SUPABASE_SERVICE_ROLE_KEY // Never expose to the client!
);

// ══════════════════════════════════════════════════════════════════════════════
// SHARED: Verify the JWT user exists in public.users and return their UUID.
// This is the canonical user_id for all foreign-key inserts.
// ══════════════════════════════════════════════════════════════════════════════
async function resolveUserId(req, res) {
  const jwtId = req.user?.id;

  console.log(`🔍 [Addresses] req.user = ${JSON.stringify(req.user)}`);

  if (!jwtId) {
    res.status(401).json({ success: false, message: 'Not authenticated.' });
    return null;
  }

  // Confirm the UUID actually exists in public.users (the table the FK references)
  const { data: userRow, error } = await supabase
    .from('users')
    .select('id')
    .eq('id', jwtId)
    .maybeSingle();

  if (error) {
    console.error('❌ [Addresses] resolveUserId DB error:', error.message);
    res.status(500).json({ success: false, message: 'Database error verifying user.' });
    return null;
  }

  if (!userRow) {
    console.error(`❌ [Addresses] User ${jwtId} not found in public.users — FK would fail`);
    res.status(403).json({
      success: false,
      message: `User ID ${jwtId} not found in the users table. Cannot save address.`,
    });
    return null;
  }

  console.log(`✅ [Addresses] Resolved user_id = ${userRow.id}`);
  return userRow.id;
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/addresses  — List all addresses for the authenticated user
// ══════════════════════════════════════════════════════════════════════════════
router.get('/', authenticateToken, async (req, res) => {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  try {
    const { data, error } = await supabase
      .from('shipping_addresses')
      .select('*')
      .eq('user_id', userId)
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
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const {
    full_name,
    phone,
    address_line1,
    address_line2,
    city,
    governorate,
    is_default = false,
  } = req.body;

  console.log(`📦 [Addresses] POST payload:`, {
    user_id: userId,
    full_name,
    phone,
    address_line1,
    address_line2,
    city,
    governorate,
    is_default,
  });

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
      const { error: clearErr } = await supabase
        .from('shipping_addresses')
        .update({ is_default: false })
        .eq('user_id', userId)
        .eq('is_default', true);
      if (clearErr) console.warn('⚠️ [Addresses] Could not clear old defaults:', clearErr.message);
    }

    const addressData = {
      user_id: userId,
      full_name,
      phone,
      address_line1,
      address_line2: address_line2 || null,
      city,
      governorate,
      is_default,
    };

    console.log(`📝 [Addresses] Inserting into shipping_addresses:`, addressData);

    const { data, error } = await supabase
      .from('shipping_addresses')
      .insert(addressData)
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ [Addresses] Created address ${data.id} for user ${userId}`);
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
  const userId = await resolveUserId(req, res);
  if (!userId) return;

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
    if (existing.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    // If setting as default, clear other defaults
    if (is_default) {
      await supabase
        .from('shipping_addresses')
        .update({ is_default: false })
        .eq('user_id', userId)
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

    console.log(`📝 [Addresses] Updating ${req.params.id}:`, updates);

    const { data, error } = await supabase
      .from('shipping_addresses')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    console.log(`✅ [Addresses] Updated address ${req.params.id} for user ${userId}`);
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
  const userId = await resolveUserId(req, res);
  if (!userId) return;

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
    if (existing.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'Forbidden.' });
    }

    const { error } = await supabase
      .from('shipping_addresses')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;

    console.log(`✅ [Addresses] Deleted address ${req.params.id} for user ${userId}`);
    return res.json({ success: true, message: 'Address deleted successfully.' });
  } catch (err) {
    console.error('❌ [Addresses] DELETE /:id Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
