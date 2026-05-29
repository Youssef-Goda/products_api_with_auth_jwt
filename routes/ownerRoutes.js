/**
 * ownerRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * God-Mode endpoints — accessible by the OWNER role only.
 * All routes require a valid JWT with role === 'owner'.
 *
 * Mount in server.js:
 *   const ownerRoutes = require('./routes/ownerRoutes');
 *   app.use('/api/owner', ownerRoutes);
 */

const router = require('express').Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const { checkRole }         = require('../middlewares/checkRole');
const { createClient }      = require('@supabase/supabase-js');

// Supabase admin client for unrestricted reads
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

// Shorthand — every route here requires owner token
const ownerOnly = [authenticateToken, checkRole(['owner'])];

// ── GET /api/owner/financials/summary ─────────────────────────────────────────
// Net revenue, vendor payouts, platform profit
router.get('/financials/summary', ...ownerOnly, async (req, res) => {
  try {
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('total_amount, vendor_payout, status')
      .eq('status', 'delivered');

    if (error) throw error;

    const totalRevenue = orders.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0);
    const totalPayouts = orders.reduce((s, o) => s + (parseFloat(o.vendor_payout) || 0), 0);
    const netProfit    = totalRevenue - totalPayouts;

    res.json({
      success: true,
      data: {
        totalRevenue:  totalRevenue.toFixed(2),
        totalPayouts:  totalPayouts.toFixed(2),
        netProfit:     netProfit.toFixed(2),
        ordersCount:   orders.length,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/owner/vendor-balances ────────────────────────────────────────────
// Per-vendor revenue breakdown
router.get('/vendor-balances', ...ownerOnly, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('vendor_id, vendor_payout, total_amount, status');

    if (error) throw error;

    // Group by vendor
    const balances = {};
    for (const row of data) {
      const vid = row.vendor_id;
      if (!vid) continue;
      if (!balances[vid]) balances[vid] = { vendorId: vid, totalRevenue: 0, totalPayout: 0, orderCount: 0 };
      balances[vid].totalRevenue += parseFloat(row.total_amount) || 0;
      balances[vid].totalPayout  += parseFloat(row.vendor_payout) || 0;
      balances[vid].orderCount++;
    }

    res.json({ success: true, data: Object.values(balances) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/owner/audit-log ──────────────────────────────────────────────────
// Admin & owner activity log (requires an `audit_logs` table)
router.get('/audit-log', ...ownerOnly, async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit)  || 50;
    const offset = parseInt(req.query.offset) || 0;

    const { data, error, count } = await supabaseAdmin
      .from('audit_logs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    res.json({ success: true, data, total: count });
  } catch (err) {
    // Graceful: table may not exist yet
    res.json({ success: true, data: [], total: 0, note: 'audit_logs table not yet created.' });
  }
});

// ── GET /api/owner/system-health ──────────────────────────────────────────────
// Basic system health snapshot
router.get('/system-health', ...ownerOnly, async (req, res) => {
  const start = Date.now();
  try {
    await supabaseAdmin.from('users').select('id').limit(1);
    const dbLatencyMs = Date.now() - start;

    res.json({
      success: true,
      data: {
        status:       'healthy',
        dbLatencyMs,
        uptime:       Math.floor(process.uptime()),
        memUsageMB:   (process.memoryUsage().rss / 1024 / 1024).toFixed(1),
        nodeVersion:  process.version,
        timestamp:    new Date().toISOString(),
      },
    });
  } catch (err) {
    res.json({ success: false, data: { status: 'degraded', error: err.message } });
  }
});

// ── GET /api/owner/growth-metrics ─────────────────────────────────────────────
// Platform growth: new users and orders by day (last 30 days)
router.get('/growth-metrics', ...ownerOnly, async (req, res) => {
  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceISO = since.toISOString();

    const [{ data: users, error: ue }, { data: orders, error: oe }] = await Promise.all([
      supabaseAdmin.from('users').select('created_at').gte('created_at', sinceISO),
      supabaseAdmin.from('orders').select('created_at').gte('created_at', sinceISO),
    ]);

    if (ue || oe) throw ue || oe;

    res.json({ success: true, data: { newUsers: users?.length ?? 0, newOrders: orders?.length ?? 0 } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/owner/settings ───────────────────────────────────────────────────
// GET global platform settings
router.get('/settings', ...ownerOnly, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, data: data ?? {} });
  } catch (err) {
    res.json({ success: true, data: {}, note: 'platform_settings table not yet created.' });
  }
});

// ── PATCH /api/owner/settings ─────────────────────────────────────────────────
// Update global platform settings
router.patch('/settings', ...ownerOnly, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .upsert({ id: 1, ...req.body, updated_at: new Date().toISOString() })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/owner/promote/:userId ────────────────────────────────────────────
// Promote or demote a user's role (owner only)
router.patch('/users/:id/promote', ...ownerOnly, async (req, res) => {
  const { id }   = req.params;
  const { role } = req.body;

  const validRoles = ['owner', 'admin', 'moderator', 'vendor', 'customer'];
  if (!role || !validRoles.includes(role)) {
    return res.status(400).json({ success: false, message: `Invalid role. Valid: ${validRoles.join(', ')}` });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .update({ role })
      .eq('id', id)
      .select('id, email, role')
      .single();

    if (error) throw error;
    res.json({ success: true, message: `User promoted to ${role}.`, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
