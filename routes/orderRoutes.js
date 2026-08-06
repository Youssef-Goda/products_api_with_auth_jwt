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
const { checkRole } = require('../middlewares/checkRole');
const { notifyOrderStatusChanged } = require('../services/orderNotificationService');
const { sendOrderConfirmationEmail } = require('../utils/otpHelper');
const { createClient } = require('@supabase/supabase-js');
const { logActivity } = require('../services/activityLogger');

// ── Supabase admin client (bypass RLS for server-side ops) ──────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // Never expose this to Flutter!
);

// ── Allowed status transitions ───────────────────────────────────────────────
const VALID_STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];

// ══════════════════════════════════════════════════════════════════════════════
// SHARED: Verify JWT user exists in public.users and return canonical UUID.
// Mirrors the same helper in addressRoutes.js so the JWT id always matches
// the FK that points to public.users(id), NOT auth.users.
// ══════════════════════════════════════════════════════════════════════════════
async function resolveUserId(req, res) {
  const jwtId = req.user?.id;
  console.log(`🔍 [Orders] req.user = ${JSON.stringify(req.user)}`);
  if (!jwtId) {
    res.status(401).json({ success: false, message: 'Not authenticated.' });
    return null;
  }
  const { data: userRow, error } = await supabase
    .from('users')
    .select('id')
    .eq('id', jwtId)
    .maybeSingle();
  if (error) {
    console.error('❌ [Orders] resolveUserId DB error:', error.message);
    res.status(500).json({ success: false, message: 'Database error verifying user.' });
    return null;
  }
  if (!userRow) {
    console.error(`❌ [Orders] User ${jwtId} not found in public.users`);
    res.status(403).json({ success: false, message: `User ${jwtId} not found in public.users.` });
    return null;
  }
  return userRow.id;
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/orders  — Place a new order (atomic: order row + items)
// Body: { shipping_address_id, payment_method, items[], subtotal, tax, total, notes? }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/', authenticateToken, async (req, res) => {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  const {
    shipping_address_id,
    payment_method = 'cod',
    items,
    subtotal,
    tax,
    total,
    notes,
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────
  if (!shipping_address_id) {
    return res.status(400).json({ success: false, message: 'shipping_address_id is required.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: 'items must be a non-empty array.' });
  }

  console.log(`📦 [Orders] POST payload: userId=${userId}, items=${items.length}, total=${total}`);

  try {
    // 0️⃣ Fetch user's role to determine velocity check permissions
    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (userErr) throw userErr;

    const userRole = (userRow?.role || '').toLowerCase();
    // Only regular users/customers are subject to the 3-active-order limit.
    // Admins, owners and moderators are exempt.
    const isPrivileged = ['admin', 'owner', 'moderator', 'super_admin'].includes(userRole);
    if (!isPrivileged) {
      // Count orders that are still "in-flight" (not yet delivered or cancelled)
      const activeStatuses = ['pending', 'confirmed', 'processing', 'shipped'];
      const { data: activeOrders, error: activeErr } = await supabase
        .from('orders')
        .select('id')
        .eq('user_id', userId)
        .in('status', activeStatuses);

      if (activeErr) throw activeErr;

      if (activeOrders && activeOrders.length >= 3) {
        return res.status(400).json({
          success: false,
          message: 'عذراً، لديك طلبات قيد التنفيذ بالفعل، يرجى انتظار توصيلها أولاً'
        });
      }
    }

    // 1️⃣  Insert the order row
    const { data: orderRow, error: orderErr } = await supabase
      .from('orders')
      .insert({
        user_id: userId,
        shipping_address_id,
        payment_method,
        status: 'pending',
        subtotal,
        tax,
        total,
        notes: notes || null,
      })
      .select()
      .single();

    if (orderErr) throw orderErr;
    const orderId = orderRow.id;
    console.log(`✅ [Orders] Order row created: ${orderId}`);

    // 2️⃣  Bulk-insert order_items
    const itemsPayload = items.map((item) => ({
      order_id: orderId,
      product_id: item.product_id,
      product_name: item.product_name,
      product_code: item.product_code ?? null,
      image_url: item.image_url ?? null,
      unit_price: item.unit_price,
      quantity: item.quantity,
      subtotal: item.subtotal,
    }));

    const { error: itemsErr } = await supabase.from('order_items').insert(itemsPayload);
    if (itemsErr) throw itemsErr;
    console.log(`✅ [Orders] ${itemsPayload.length} order_items inserted`);

    // 3️⃣  Clear the user's cart (server-side, so all devices sync)
    const { error: cartErr } = await supabase
      .from('cart_items')
      .delete()
      .eq('user_id', userId);
    if (cartErr) {
      // Non-fatal: log but don't abort the order
      console.warn(`⚠️ [Orders] Cart clear failed for user ${userId}: ${cartErr.message}`);
    } else {
      console.log(`🛒 [Orders] Cart cleared for user ${userId}`);
    }

    // 4️⃣  Fetch full order (with items + address) to return
    const { data: fullOrder, error: fetchErr } = await supabase
      .from('orders')
      .select('*, order_items(*), shipping_addresses(*)')
      .eq('id', orderId)
      .single();

    if (fetchErr) throw fetchErr;

    // 5️⃣  Send order confirmation email (fire-and-forget)
    try {
      const { data: userRow } = await supabase
        .from('users')
        .select('email, firstName')
        .eq('id', userId)
        .maybeSingle();
      if (userRow?.email) {
        sendOrderConfirmationEmail(userRow.email, fullOrder, userRow.firstName || 'Customer')
          .catch(e => console.warn('⚠️ Order email skipped:', e.message));
      }
    } catch (emailErr) {
      console.warn('⚠️ Could not send order email:', emailErr.message);
    }

    return res.status(201).json({ success: true, data: fullOrder });
  } catch (err) {
    console.error('❌ [Orders] POST / Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders  — List orders for the authenticated user
// ══════════════════════════════════════════════════════════════════════════════
router.get('/', authenticateToken, async (req, res) => {
  const userId = await resolveUserId(req, res);
  if (!userId) return;
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*), shipping_addresses(*)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data });
  } catch (err) {
    console.error('❌ Fetch Orders Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/all  — Admin: list all orders (Admin / Super-Admin only)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/all', authenticateToken, checkRole(['admin', 'super_admin']), async (req, res) => {
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
// PATCH /api/orders/:id/status  — Update order status (Admin / Super-Admin only)
// Body: { status: string }
// ══════════════════════════════════════════════════════════════════════════════
router.patch('/:id/status', authenticateToken, checkRole(['admin', 'super_admin']), async (req, res) => {
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

    // Log activity
    await logActivity(req.user.id, 'UPDATE_ORDER_STATUS', 'order', req.params.id, {
      oldStatus: order.status,
      newStatus: status
    });

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

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/orders/:id/cancel  — User cancels their own order (allowed ONLY if 'pending')
// ══════════════════════════════════════════════════════════════════════════════
router.post('/:id/cancel', authenticateToken, async (req, res) => {
  const userId = await resolveUserId(req, res);
  if (!userId) return;

  try {
    // 1️⃣ Fetch the order to verify ownership and status
    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('id, user_id, status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Check ownership (only owner of order can cancel)
    if (order.user_id !== userId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to cancel this order.' });
    }

    // Check status — user can cancel if pending or confirmed (before processing starts)
    const cancellableStatuses = ['pending', 'confirmed'];
    if (!cancellableStatuses.includes(order.status)) {
      return res.status(400).json({ success: false, message: `Cannot cancel an order that is already "${order.status}". Only pending or confirmed orders can be cancelled.` });
    }

    // 2️⃣ Update the order status to cancelled
    const { data: updated, error: updateErr } = await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*, order_items(*), shipping_addresses(*)')
      .single();

    if (updateErr) throw updateErr;

    // Log activity
    await logActivity(userId, 'CANCEL_ORDER', 'order', req.params.id, {
      cancelledBy: userId === order.user_id ? 'user' : 'admin',
      previousStatus: order.status
    });

    console.log(`✅ Order ${order.id} was cancelled by user.`);
    return res.json({ success: true, message: 'Order cancelled successfully', data: updated });
  } catch (err) {
    console.error('❌ Cancel Order Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
