const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const { checkRole } = require('../middlewares/checkRole');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

router.get('/dashboard', authenticateToken, checkRole(['owner', 'admin', 'vendor']), async (req, res) => {
  try {
    // 1. Fetch KPI raw data
    const [
      { data: nonCancelledOrders, error: err1 },
      { count: totalOrders, error: err2 },
      { data: allProducts, error: err3 }
    ] = await Promise.all([
      supabase.from('orders').select('total').neq('status', 'cancelled').neq('status', 'refunded'),
      supabase.from('orders').select('*', { count: 'exact', head: true }),
      supabase.from('Products').select('rating')
    ]);

    if (err1 || err2 || err3) {
      throw err1 || err2 || err3;
    }

    const totalRevenue = nonCancelledOrders ? nonCancelledOrders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0) : 0;
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;
    const avgRating = allProducts && allProducts.length > 0 
      ? allProducts.reduce((sum, p) => sum + (p.rating || 0), 0) / allProducts.length 
      : 0;

    // 2. Fetch Revenue Timeline (last 6 months)
    const { data: timelineData, error: timelineErr } = await supabase
      .from('orders')
      .select('total, created_at')
      .neq('status', 'cancelled')
      .neq('status', 'refunded')
      .order('created_at', { ascending: true });

    if (timelineErr) throw timelineErr;

    const monthlyRevenue = {};
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // Initialize last 6 months with 0
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${monthNames[d.getMonth()]} ${d.getFullYear().toString().substring(2)}`;
      monthlyRevenue[key] = 0;
    }

    if (timelineData) {
      timelineData.forEach(o => {
        if (!o.created_at) return;
        const d = new Date(o.created_at);
        const key = `${monthNames[d.getMonth()]} ${d.getFullYear().toString().substring(2)}`;
        if (monthlyRevenue[key] !== undefined) {
          monthlyRevenue[key] += parseFloat(o.total) || 0;
        }
      });
    }

    const revenueTimeline = Object.entries(monthlyRevenue).map(([month, revenue]) => ({
      month,
      revenue: Math.round(revenue)
    }));

    // 3. Fetch Top Products
    const { data: orderItems, error: itemsErr } = await supabase
      .from('order_items')
      .select('product_name, quantity, subtotal');

    if (itemsErr) throw itemsErr;

    const productSales = {};
    if (orderItems) {
      orderItems.forEach(item => {
        const name = item.product_name || 'Unknown Product';
        if (!productSales[name]) {
          productSales[name] = { name, sold: 0, revenue: 0 };
        }
        productSales[name].sold += item.quantity || 0;
        productSales[name].revenue += parseFloat(item.subtotal) || 0;
      });
    }

    const topProducts = Object.values(productSales)
      .sort((a, b) => b.sold - a.sold)
      .slice(0, 5)
      .map(p => ({
        name: p.name,
        sold: p.sold,
        revenue: `EGP ${p.revenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        growth: '+10%'
      }));

    // 4. Fetch Recent Orders
    const { data: recentOrdersData, error: recentErr } = await supabase
      .from('orders')
      .select('id, total, status, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    if (recentErr) throw recentErr;

    const recentOrders = recentOrdersData ? recentOrdersData.map(o => {
      const d = new Date(o.created_at);
      const timeStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return {
        id: `#${o.id.substring(0, 8)}`,
        fullId: o.id,
        time: timeStr,
        amount: `EGP ${(parseFloat(o.total) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
        status: o.status
      };
    }) : [];

    // 5. Build KPIs response
    const kpis = {
      totalRevenue: `EGP ${totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      totalOrders: totalOrders.toString(),
      avgOrder: `EGP ${avgOrderValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      rating: `${avgRating.toFixed(1)}★`,
      growthPercent: '+12.5%',
    };

    res.json({
      success: true,
      data: {
        kpis,
        revenueTimeline,
        topProducts,
        recentOrders
      }
    });

  } catch (err) {
    console.error('❌ Analytics error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
