/**
 * moderationRoutes.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides real data for the Moderation Dashboard:
 *   GET /api/moderation/summary  → KPI stats + orders + products + activity logs
 *
 * Data sources (100% real from DB):
 *   - orders         → pending orders (moderation queue)
 *   - Products       → all products with details
 *   - activity_logs  → recent admin/mod actions
 *   - users          → user info for logs
 */

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const { checkRole } = require('../middlewares/checkRole');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── GET /summary ─────────────────────────────────────────────────────────────
router.get(
  '/summary',
  authenticateToken,
  checkRole(['owner', 'admin', 'moderator']),
  async (req, res) => {
    try {
      // ── 1. Orders needing attention (pending / processing) ──────────────────
      const { data: pendingOrders, error: ordErr } = await supabase
        .from('orders')
        .select('id, status, total, created_at, user_id')
        .in('status', ['pending', 'processing', 'confirmed'])
        .order('created_at', { ascending: true })
        .limit(30);

      if (ordErr) throw ordErr;

      // ── 2. Cancelled orders count (last 30 days) ──────────────────────────
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const { count: cancelledCount } = await supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'cancelled')
        .gte('created_at', thirtyDaysAgo);

      // ── 3. All products ───────────────────────────────────────────────────
      const { data: products, error: prodErr } = await supabase
        .from('Products')
        .select('id, name, price, oldPrice, rating, countInStock, imageUrls, createdAt, updatedAt, categoryId, attributes')
        .order('createdAt', { ascending: false })
        .limit(50);

      if (prodErr) throw prodErr;

      // ── 4. Recent activity logs (last 20) ────────────────────────────────
      const { data: logs, error: logErr } = await supabase
        .from('activity_logs')
        .select('id, user_id, action, entity_type, entity_id, details, created_at')
        .order('created_at', { ascending: false })
        .limit(20);

      if (logErr) throw logErr;

      // ── 5. Fetch user data for logs ───────────────────────────────────────
      const userIds = [...new Set((logs || []).map(l => l.user_id).filter(Boolean))];
      let usersMap = {};
      if (userIds.length > 0) {
        const { data: usersData } = await supabase
          .from('users')
          .select('id, firstName, lastName, role')
          .in('id', userIds);
        (usersData || []).forEach(u => { usersMap[u.id] = u; });
      }

      // ── 6. Format pending orders ─────────────────────────────────────────
      const now = new Date();
      const formattedOrders = (pendingOrders || []).map(o => {
        const created = new Date(o.created_at);
        const diffMs = now - created;
        const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHrs / 24);

        let timeStr;
        if (diffHrs < 1) {
          const diffMin = Math.floor(diffMs / (1000 * 60));
          timeStr = `${diffMin} min ago`;
        } else if (diffHrs < 24) {
          timeStr = `${diffHrs} hr${diffHrs > 1 ? 's' : ''} ago`;
        } else if (diffDays === 1) {
          timeStr = 'Yesterday';
        } else {
          timeStr = `${diffDays} days ago`;
        }

        // Flag orders waiting more than 24 hrs as high priority
        const priority = diffHrs >= 24 ? 'High' : diffHrs >= 6 ? 'Medium' : 'Normal';

        return {
          id: `#${o.id.substring(0, 8).toUpperCase()}`,
          fullId: o.id,
          status: o.status,
          total: `EGP ${(parseFloat(o.total) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
          totalRaw: parseFloat(o.total) || 0,
          createdAt: o.created_at,
          timeAgo: timeStr,
          waitingHours: diffHrs,
          priority,
        };
      });

      // ── 7. Format products ───────────────────────────────────────────────
      const formattedProducts = (products || []).map(p => {
        const created = new Date(p.createdAt);
        const diffMs = now - created;
        const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHrs / 24);

        let submittedStr;
        if (diffHrs < 1) {
          submittedStr = 'Just now';
        } else if (diffHrs < 24) {
          submittedStr = `${diffHrs} hr${diffHrs > 1 ? 's' : ''} ago`;
        } else if (diffDays === 1) {
          submittedStr = 'Yesterday';
        } else {
          submittedStr = `${diffDays} days ago`;
        }

        const imageUrl = (p.imageUrls && Array.isArray(p.imageUrls) && p.imageUrls.length > 0)
          ? p.imageUrls[0]
          : null;

        return {
          id: p.id,
          name: p.name || 'Unnamed Product',
          price: `EGP ${(parseFloat(p.price) || 0).toLocaleString('en-US')}`,
          priceRaw: parseFloat(p.price) || 0,
          oldPrice: p.oldPrice ? `EGP ${parseFloat(p.oldPrice).toLocaleString('en-US')}` : null,
          rating: p.rating || 0,
          countInStock: p.countInStock || 0,
          imageUrl,
          submittedAgo: submittedStr,
          updatedAgo: (() => {
            const upd = new Date(p.updatedAt);
            const updDiffHrs = Math.floor((now - upd) / (1000 * 60 * 60));
            if (updDiffHrs < 1) return 'Just now';
            if (updDiffHrs < 24) return `${updDiffHrs} hr${updDiffHrs > 1 ? 's' : ''} ago`;
            const updDiffDays = Math.floor(updDiffHrs / 24);
            return updDiffDays === 1 ? 'Yesterday' : `${updDiffDays} days ago`;
          })(),
        };
      });

      // ── 8. Format activity logs ──────────────────────────────────────────
      const ACTION_LABELS = {
        CREATE_PRODUCT:    'Added Product',
        UPDATE_PRODUCT:    'Updated Product',
        DELETE_PRODUCT:    'Deleted Product',
        CREATE_BANNER:     'Added Banner',
        DELETE_BANNER:     'Deleted Banner',
        DELETE_USER:       'Deleted User',
        UPDATE_USER_ROLE:  'Changed User Role',
        TOGGLE_USER_STATUS:'Toggled User Status',
      };

      const formattedLogs = (logs || []).map(l => {
        const actor = usersMap[l.user_id];
        const actorName = actor
          ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() || 'Unknown'
          : 'Unknown';
        const actorRole = actor?.role || 'user';

        const created = new Date(l.created_at);
        const diffMs = now - created;
        const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
        const diffDays = Math.floor(diffHrs / 24);

        let timeStr;
        if (diffHrs < 1) {
          const diffMin = Math.floor(diffMs / (1000 * 60));
          timeStr = `${diffMin} min ago`;
        } else if (diffHrs < 24) {
          timeStr = `${diffHrs} hr${diffHrs > 1 ? 's' : ''} ago`;
        } else if (diffDays === 1) {
          timeStr = 'Yesterday';
        } else {
          // Show full date/time for older logs
          timeStr = `${created.getDate().toString().padStart(2, '0')}/${(created.getMonth()+1).toString().padStart(2,'0')}/${created.getFullYear()} ${created.getHours().toString().padStart(2,'0')}:${created.getMinutes().toString().padStart(2,'0')}`;
        }

        return {
          id: l.id,
          actorName,
          actorRole,
          action: l.action,
          actionLabel: ACTION_LABELS[l.action] || l.action,
          entityType: l.entity_type,
          entityId: l.entity_id,
          details: l.details || {},
          timeAgo: timeStr,
          createdAt: l.created_at,
        };
      });

      // ── 9. KPI Stats ─────────────────────────────────────────────────────
      const totalPendingOrders = (pendingOrders || []).length;
      const highPriorityOrders = formattedOrders.filter(o => o.priority === 'High').length;
      const totalProducts = formattedProducts.length;
      const lowStockProducts = formattedProducts.filter(p => p.countInStock < 5).length;
      const totalActivity = formattedLogs.length;
      const todayLogs = formattedLogs.filter(l => {
        const d = new Date(l.createdAt);
        return d.toDateString() === now.toDateString();
      }).length;

      res.json({
        success: true,
        data: {
          stats: {
            pendingOrders: totalPendingOrders,
            highPriorityOrders,
            totalProducts,
            lowStockProducts,
            cancelledLast30Days: cancelledCount || 0,
            activityToday: todayLogs,
          },
          orders: formattedOrders,
          products: formattedProducts,
          activityLogs: formattedLogs,
        }
      });

    } catch (err) {
      console.error('❌ Moderation summary error:', err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  }
);

module.exports = router;
