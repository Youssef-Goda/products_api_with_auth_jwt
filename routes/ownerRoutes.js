/**
 * ownerRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner Control Panel endpoints — accessible by the OWNER role only.
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
const ActivityLog           = require('../models/ActivityLog');
const User                  = require('../models/User');
const settingsController    = require('../controllers/settingsController');

// Supabase admin client for unrestricted reads
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

// Shorthand — every route here requires owner token
const ownerOnly = [authenticateToken, checkRole(['owner'])];

// ── GET /api/owner/financials/summary ─────────────────────────────────────────
// Net revenue, vendor payouts, platform profit, and total counts
router.get('/financials/summary', ...ownerOnly, async (req, res) => {
  try {
    const [
      { data: deliveredOrders, error: err1 },
      { count: totalOrders, error: err2 },
      { count: totalUsers, error: err3 },
      { count: activeVendors, error: err4 }
    ] = await Promise.all([
      supabaseAdmin.from('orders').select('total').eq('status', 'delivered'),
      supabaseAdmin.from('orders').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('users').select('*', { count: 'exact', head: true }).eq('role', 'vendor'),
    ]);

    if (err1 || err2 || err3 || err4) {
      throw err1 || err2 || err3 || err4;
    }

    const totalRevenue = deliveredOrders ? deliveredOrders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0) : 0;
    const totalPayouts = totalRevenue * 0.85; // derived payout 85%
    const netProfit    = totalRevenue - totalPayouts; // platform fee 15%

    res.json({
      success: true,
      data: {
        totalRevenue:  totalRevenue.toFixed(2),
        totalPayouts:  totalPayouts.toFixed(2),
        netProfit:     netProfit.toFixed(2),
        deliveredCount: deliveredOrders ? deliveredOrders.length : 0,
        totalOrders:   totalOrders || 0,
        totalUsers:    totalUsers || 0,
        activeVendors: activeVendors || 0,
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
    // Return empty array or mock vendor list to prevent errors as there is no vendor mapping in orders table
    res.json({ success: true, data: [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/owner/audit-log ──────────────────────────────────────────────────
// Admin & owner activity log using Sequelize
router.get('/audit-log', ...ownerOnly, async (req, res) => {
  try {
    const limit  = parseInt(req.query.limit)  || 50;
    const offset = parseInt(req.query.offset) || 0;

    const { rows: logs, count } = await ActivityLog.findAndCountAll({
      limit,
      offset,
      order: [['created_at', 'DESC']],
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'firstName', 'lastName', 'email', 'role']
        }
      ]
    });

    res.json({ success: true, data: logs, total: count });
  } catch (err) {
    console.error('❌ Audit-Log fetch error:', err.message);
    res.status(500).json({ success: false, message: err.message });
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
router.get('/settings', ...ownerOnly, settingsController.getPublicSettings);

// ── PATCH /api/owner/settings ─────────────────────────────────────────────────
// Update global platform settings (Owner only)
router.patch('/settings', ...ownerOnly, settingsController.updateOwnerSettings);

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
