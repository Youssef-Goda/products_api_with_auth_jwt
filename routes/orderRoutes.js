/**
 * orderRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles order management with automatic FCM push notifications on status
 * changes.  Orders are stored in Supabase (accessed via Sequelize / raw SQL).
 *
 * Register in server.js:
 *   const orderRoutes = require('./routes/orderRoutes');
 *   app.use('/api/orders', orderRoutes);
 *
 * Supabase table (minimal schema):
 *   CREATE TABLE orders (
 *     id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *     user_id     UUID NOT NULL REFERENCES users(id),
 *     status      TEXT NOT NULL DEFAULT 'pending',
 *     total       NUMERIC(10,2),
 *     created_at  TIMESTAMPTZ DEFAULT now(),
 *     updated_at  TIMESTAMPTZ DEFAULT now()
 *   );
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const { notifyOrderStatusChanged } = require('../services/orderNotificationService');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase admin client (bypass RLS for server-side ops) ──────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // Never expose this to Flutter!
);

// ── Allowed status transitions ───────────────────────────────────────────────
const VALID_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders  — List orders for the authenticated user
// ══════════════════════════════════════════════════════════════════════════════
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Fetch Orders Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/all  — Admin: list all orders
// ══════════════════════════════════════════════════════════════════════════════
router.get('/all', authenticateToken, async (req, res) => {
  // Optionally guard with role check:
  // if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Forbidden' });
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, users(firstName, lastName, email)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Fetch All Orders Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/:id  — Get a single order by ID
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Order not found' });

    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Fetch Order Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/orders/:id/status  — Update order status + trigger push notification
// Body: { status: string }
// ══════════════════════════════════════════════════════════════════════════════
router.patch('/:id/status', authenticateToken, async (req, res) => {
  const { status } = req.body;

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  try {
    // Fetch the order first to get the owner's user_id
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('id, user_id, status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Skip update if status hasn't changed
    if (order.status === status) {
      return res.json({ success: true, message: 'Status unchanged', data: order });
    }

    // Update the order status
    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateError) throw updateError;

    console.log(`✅ Order ${req.params.id} status updated: ${order.status} → ${status}`);

    // ── 🔔 Fire push notification (non-blocking) ──────────────────────────
    notifyOrderStatusChanged(order.id, status, order.user_id).catch((e) =>
      console.error('⚠️ Notification fire-and-forget error:', e.message)
    );

    return res.json({ success: true, message: `Order status updated to "${status}"`, data: updated });
  } catch (err) {
    console.error('❌ Update Order Status Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
