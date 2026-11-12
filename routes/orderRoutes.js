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
const { QueryTypes } = require('sequelize');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { checkRole } = require('../middlewares/checkRole');
const { notifyOrderStatusChanged } = require('../services/orderNotificationService');
const { createClient } = require('@supabase/supabase-js');
const { logActivity } = require('../services/activityLogger');
const { sendOrderConfirmationEmail } = require('../utils/otpHelper');
const { reduceStockForOrder, restoreStockForOrder } = require('../services/stockService');
const Product = require('../models/Product');
const { hideInternalOrderCosts } = require('../services/internalFinance');
const sequelize = require('../config/database');
const { createOrderWithItems } = require('../services/orderCreationService');
const { calculatePromotionCheckout } = require('../services/promotionCheckout');
const { transitionOrderReservations } = require('../services/promotionRedemptionService');
const { cancellationBlock, customerCancellationBlock } = require('../services/orderPaymentPolicy');
const { orderStatusTransitionBlock } = require('../services/orderStatusPolicy');

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
    coupon_code,
  } = req.body;
  const idempotencyKey = String(req.get('Idempotency-Key') || req.body?.idempotency_key || '').trim();

  // ── Validation ──────────────────────────────────────────────────────────
  if (!shipping_address_id) {
    return res.status(400).json({ success: false, message: 'shipping_address_id is required.' });
  }
  if (!['cod', 'card', 'wallet', 'cash'].includes(String(payment_method).toLowerCase())) {
    return res.status(400).json({ success:false,code:'INVALID_PAYMENT_METHOD',message:'Choose a supported payment method.' });
  }
  const normalizedPaymentMethod=String(payment_method).toLowerCase();
  if (idempotencyKey.length > 100) return res.status(400).json({ success:false,code:'INVALID_IDEMPOTENCY_KEY',message:'Idempotency key is too long.' });

  console.log(`📦 [Orders] POST checkout request: userId=${userId}`);

  try {
    // 0️⃣ Fetch user's role to determine velocity check permissions
    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (userErr) throw userErr;

    const userRole = (userRow?.role || '').toLowerCase();
    const existingForIdempotency = idempotencyKey
      ? await sequelize.query('SELECT id FROM public.orders WHERE user_id=:userId AND checkout_idempotency_key=:key LIMIT 1', {type:QueryTypes.SELECT,replacements:{userId,idempotencyKey}})
      : [];
    const isExistingReplay=existingForIdempotency.length>0;
    // Only regular users/customers are subject to the 3-active-order limit.
    // Admins, owners and reviewers are exempt.
    const isPrivileged = ['admin', 'owner', 'reviewer', 'super_admin'].includes(userRole);
    if (!isPrivileged && !isExistingReplay) {
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
          message: 'Sorry, you already have orders in progress. Please wait until they are delivered first.'
        });
      }
    }

    // Persist the order and its server-priced cost snapshots atomically.
    const initialStatus = normalizedPaymentMethod === 'cod' ? 'pending' : 'pending_payment';
    const { orderRow, itemsPayload, duplicate } = await createOrderWithItems({
      sequelize,
      Product,
      initialStatus,
      items,
      orderData: {
        user_id: userId,
        shipping_address_id,
        payment_method: normalizedPaymentMethod,
        payment_status: 'pending',
        stock_status: normalizedPaymentMethod === 'cod' ? 'pending' : null,
        subtotal,
        tax,
        total,
        notes: notes || null,
      checkout_idempotency_key: idempotencyKey || null,
      },
      insertOrder: async ({ transaction, initialStatus: status, orderData }) => {
        const insertForStatus = async (targetStatus) => {
          const values = { ...orderData, status: targetStatus };
          const columns = Object.keys(values).filter((column) => values[column] !== undefined);
          const [rows] = await sequelize.query(
            `INSERT INTO public.orders (${columns.map((column) => `"${column}"`).join(', ')})
             VALUES (${columns.map((column) => `:${column}`).join(', ')})
             RETURNING *`,
            { transaction, replacements: values },
          );
          return rows?.[0];
        };

        // Keep the existing online-payment status fallback without aborting the transaction.
        await sequelize.query('SAVEPOINT dealio_order_status', { transaction });
        try {
          const created = await insertForStatus(status);
          await sequelize.query('RELEASE SAVEPOINT dealio_order_status', { transaction });
          return created;
        } catch (insertError) {
          if (status !== 'pending_payment') throw insertError;
          await sequelize.query('ROLLBACK TO SAVEPOINT dealio_order_status', { transaction });
          console.warn(`⚠️ [Orders] DB constraint on status 'pending_payment': ${insertError.message} — falling back to status='pending'`);
          const created = await insertForStatus('pending');
          await sequelize.query('RELEASE SAVEPOINT dealio_order_status', { transaction });
          return created;
        }
      },
      insertItems: async ({ transaction, items: rows }) => {
        for (const item of rows) {
          const columns = Object.keys(item).filter((column) => item[column] !== undefined);
          await sequelize.query(
            `INSERT INTO public.order_items (${columns.map((column) => `"${column}"`).join(', ')})
             VALUES (${columns.map((column) => `:${column}`).join(', ')})`,
            { transaction, replacements: item },
          );
        }
      },
      userId,
      idempotencyKey: idempotencyKey || null,
      prepareOrder: ({ transaction }) => calculatePromotionCheckout({
        sequelize,
        Product,
        userId,
        couponCode: coupon_code || null,
        transaction,
        lockRows: true,
        paymentMethod: normalizedPaymentMethod,
      }),
    });

    const orderId = orderRow.id;
    if (duplicate) {
      const { data: existingOrder, error: existingErr } = await supabase
        .from('orders').select('*, order_items(*), shipping_addresses(*)').eq('id', orderId).single();
      if (existingErr) throw existingErr;
      if (String(existingOrder.payment_method).toLowerCase() === 'cod' && existingOrder.stock_status !== 'done') {
        const claim = await supabase.from('orders').update({stock_status:'processing',stock_processing_started_at:new Date().toISOString()})
          .eq('id',orderId).in('stock_status',['pending','failed','processing']).select('id');
        if (claim.error) throw claim.error;
        const recovery = await reduceStockForOrder(orderId);
        if (!recovery.success) {
          await supabase.from('orders').update({stock_status:'failed',stock_processing_started_at:null}).eq('id',orderId).eq('stock_status','processing');
          return res.status(409).json({success:false,code:'INVENTORY_PENDING',message:'Order saved, but inventory is not confirmed yet. Retry this checkout request later.',inventoryStatus:'failed',orderId});
        }
        const finalized = await supabase.from('orders').update({stock_status:'done',stock_processing_started_at:null}).eq('id',orderId).eq('stock_status','processing');
        if (finalized.error) return res.status(202).json({success:true,code:'INVENTORY_FINALIZATION_PENDING',message:'Order is saved; inventory processing is being reconciled.',inventoryStatus:'processing',data:hideInternalOrderCosts(existingOrder),idempotentReplay:true});
        existingOrder.stock_status='done';
      }
      return res.status(200).json({ success:true,data:hideInternalOrderCosts(existingOrder),idempotentReplay:true });
    }
    console.log(`✅ [Orders] Order row created: ${orderId} (status=${orderRow.status})`);

    console.log(`✅ [Orders] ${itemsPayload.length} order_items inserted`);

    // COD stock movements are idempotent in the Products database. The order
    // remains discoverable if a process stops before its status is finalized.
    if (normalizedPaymentMethod === 'cod') {
      const stockResult = await reduceStockForOrder(orderId);
      if (!stockResult.success) {
        await supabase.from('orders').update({stock_status:'failed',stock_processing_started_at:null}).eq('id',orderId);
        return res.status(409).json({success:false,code:'INVENTORY_PENDING',message:stockResult.error||'Order was saved but stock is insufficient; retry after inventory is corrected.',inventoryStatus:'failed',orderId});
      }
      // Mark stock as reduced (terminal state for COD — no state-machine needed)
      const finalized = await supabase.from('orders').update({ stock_status: 'done',stock_processing_started_at:null }).eq('id', orderId).eq('stock_status','pending');
      if(finalized.error)return res.status(202).json({success:true,code:'INVENTORY_FINALIZATION_PENDING',message:'Order is saved; inventory processing is being reconciled.',inventoryStatus:'processing',orderId});
      console.log(`✅ [Orders] Stock reduced and marked done for COD order ${orderId}`);
    }

    // 4️⃣  Clear cart immediately only for Cash on Delivery (COD) orders
    // For online Paymob orders, cart is preserved until payment is confirmed by webhook
    if (normalizedPaymentMethod === 'cod') {
      const { error: cartErr } = await supabase
        .from('cart_items')
        .delete()
        .eq('user_id', userId);
      if (cartErr) {
        console.warn(`⚠️ [Orders] Cart clear failed for user ${userId}: ${cartErr.message}`);
      } else {
        console.log(`🛒 [Orders] Cart cleared for user ${userId} (COD)`);
      }
    }

    // 5️⃣  Fetch full order (with items + address) to return
    const { data: fullOrder, error: fetchErr } = await supabase
      .from('orders')
      .select('*, order_items(*), shipping_addresses(*)')
      .eq('id', orderId)
      .single();

    if (fetchErr) throw fetchErr;

    // For COD orders, send order confirmation email immediately.
    // Paymob orders are handled by the webhook in paymobController.js (avoids duplicates).
    if (normalizedPaymentMethod === 'cod') {
      try {
        const { data: userRow } = await supabase
          .from('users')
          .select('email, firstName')
          .eq('id', userId)
          .maybeSingle();

        if (userRow?.email) {
          const emailSent = await sendOrderConfirmationEmail(
            userRow.email,
            hideInternalOrderCosts(fullOrder),
            userRow.firstName || 'Customer',
          );
          if (emailSent) {
            console.log(`✅ [Orders] Order confirmation email sent for COD order ${orderId}`);
          } else {
            console.warn(`⚠️ [Orders] Order confirmation email failed for COD order ${orderId} (non-fatal)`);
          }
        }
      } catch (emailErr) {
        // Should not reach here — sendOrderConfirmationEmail never throws.
        console.error(`⚠️ [Orders] Unexpected email error for order ${orderId}:`, emailErr.message);
      }
    }

    return res.status(201).json({ success: true, data: hideInternalOrderCosts(fullOrder) });
  } catch (err) {
    console.error('❌ [Orders] POST / Error:', err.message);
    if (idempotencyKey && (err.original?.code === '23505' || err.parent?.code === '23505')) {
      const { data: replay } = await supabase.from('orders').select('*, order_items(*), shipping_addresses(*)')
        .eq('user_id', userId).eq('checkout_idempotency_key', idempotencyKey).maybeSingle();
      if (replay) return res.status(200).json({success:true,data:hideInternalOrderCosts(replay),idempotentReplay:true});
    }
    return res.status(err.status || 500).json({ success: false, code:err.code || 'ORDER_CREATE_FAILED', message: err.message });
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
      .neq('status', 'pending_payment')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ success: true, data: hideInternalOrderCosts(data) });
  } catch (err) {
    console.error('❌ Fetch Orders Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/all  — Admin: list all orders (paginated + filtered)
// Query params:
//   page, limit          — pagination (default 1, 20)
//   search               — full-text across name / email / phone / orderId / address
//   status               — exact status filter
//   governorate          — exact governorate filter
//   city                 — exact city filter
// ══════════════════════════════════════════════════════════════════════════════
router.get('/all', authenticateToken, checkRole(['admin', 'super_admin', 'owner', 'reviewer']), async (req, res) => {
  try {
    const page        = Math.max(1, parseInt(req.query.page)  || 1);
    const limit       = Math.max(1, parseInt(req.query.limit) || 20);
    const from        = (page - 1) * limit;
    const to          = from + limit - 1;
    const search      = (req.query.search      || '').trim();
    const statusFilter= (req.query.status      || '').trim().toLowerCase();
    const govFilter   = (req.query.governorate || '').trim();
    const cityFilter  = (req.query.city        || '').trim();

    // ── Base select (always join users + shipping_addresses + items) ──────────
    let query = supabase
      .from('orders')
      .select(
        '*, users(firstName, lastName, email, phoneNumber), order_items(*), shipping_addresses(*)',
        { count: 'exact' }
      )
      .order('created_at', { ascending: false });

    // ── Status filter (server-side) ───────────────────────────────────────────
    if (statusFilter && statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    // ── Governorate / City filter via shipping_addresses relation ─────────────
    // PostgREST supports nested column filters with dot notation
    if (govFilter)  query = query.eq('shipping_addresses.governorate', govFilter);
    if (cityFilter) query = query.eq('shipping_addresses.city',        cityFilter);

    // ── Full-text search & Filters ─────────────────────────────────────────────
    // Supabase PostgREST limits queries to 1000 rows by default.
    // To search "ALL database records" in memory across joined tables, we must
    // fetch everything if a search/filter is applied, bypassing the 1000 limit.
    let allRows = [];
    let filteredCount = 0;

    const hasFilters = search || (statusFilter && statusFilter !== 'all') || govFilter || cityFilter;

    if (!hasFilters) {
      // 🚀 Fast path: No search/filters, use DB-level pagination directly
      const { data, count, error } = await query
        .range(from, to);
      if (error) throw error;
      allRows = data || [];
      filteredCount = count || 0;
    } else {
      // 🔍 Slow path: Fetch ALL rows (looping past 1000 limit) to search across them
      let offset = 0;
      const CHUNK_SIZE = 1000;
      let keepFetching = true;
      let rawRows = [];

      while (keepFetching) {
        const { data, error } = await supabase
          .from('orders')
          .select('*, users(firstName, lastName, email, phoneNumber), order_items(*), shipping_addresses(*)')
          .order('created_at', { ascending: false })
          .range(offset, offset + CHUNK_SIZE - 1);

        if (error) throw error;
        if (data && data.length > 0) {
          rawRows.push(...data);
          offset += CHUNK_SIZE;
        }
        if (!data || data.length < CHUNK_SIZE) {
          keepFetching = false;
        }
      }

      // Apply status / geo filters in JS
      if (statusFilter && statusFilter !== 'all') {
        rawRows = rawRows.filter(r => (r.status || '').toLowerCase() === statusFilter);
      }
      if (govFilter) {
        rawRows = rawRows.filter(r => r.shipping_addresses?.governorate === govFilter);
      }
      if (cityFilter) {
        rawRows = rawRows.filter(r => r.shipping_addresses?.city === cityFilter);
      }

      // Apply search across Order ID, shortId, Customer Name, Email, Phone Number, City, and Governorate.
      if (search) {
        const q = search.toLowerCase();
        rawRows = rawRows.filter(r => {
          const first  = (r.users?.firstName || '').toLowerCase();
          const last   = (r.users?.lastName  || '').toLowerCase();
          const email  = (r.users?.email     || '').toLowerCase();
          const phone  = (r.users?.phoneNumber || '').toLowerCase();
          const ordId  = (r.id || '').toLowerCase();
          const shortId = ordId.length >= 8 ? ordId.slice(-8) : ordId;
          const city   = (r.shipping_addresses?.city || '').toLowerCase();
          const gov    = (r.shipping_addresses?.governorate || '').toLowerCase();

          return (
            ordId.includes(q) ||
            shortId.includes(q) ||
            `${first} ${last}`.includes(q) ||
            email.includes(q) ||
            phone.includes(q) ||
            city.includes(q) ||
            gov.includes(q)
          );
        });
      }

      filteredCount = rawRows.length;
      allRows = rawRows.slice(from, from + limit);
    }

    const pageRows = allRows;

    // ── Global stats (ignoring all filters) for the KPI cards ────────────────
    const { count: totalGlobal } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true });

    const { data: statusCounts } = await supabase
      .from('orders')
      .select('status');

    const pendingCount   = (statusCounts || []).filter(r => r.status === 'pending').length;
    const deliveredCount = (statusCounts || []).filter(r => r.status === 'delivered').length;
    const cancelledCount = (statusCounts || []).filter(r => r.status === 'cancelled').length;

    return res.json({
      success:      true,
      data:         hideInternalOrderCosts(pageRows),
      total_count:  filteredCount,
      page,
      limit,
      global_stats: {
        total:     totalGlobal || 0,
        pending:   pendingCount,
        delivered: deliveredCount,
        cancelled: cancelledCount,
      },
    });
  } catch (err) {
    console.error('❌ Fetch All Orders Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/:id  — Get a single order by ID (with items + address)
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    // Join order_items and shipping_addresses so the Flutter OrderDetailScreen
    // receives a fully-populated order in one request — same shape as the
    // POST /orders response and the GET /orders list response.
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_items(*), shipping_addresses(*)')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Order not found' });

    // Object-Level Authorization Check (IDOR Guard)
    const userRole = (req.user?.role || '').toLowerCase();
    const isElevated = ['admin', 'owner', 'reviewer', 'super_admin'].includes(userRole);

    if (data.user_id !== req.user.id && !isElevated) {
      return res.status(403).json({ success: false, message: 'Access denied to this order' });
    }

    return res.json({ success: true, data: hideInternalOrderCosts(data) });
  } catch (err) {
    console.error('❌ Fetch Order Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/orders/:id/payment-status  — Lightweight payment status check
//
// Used by the "I Have Paid" button in the app to verify server-side that Paymob
// has confirmed the payment via webhook BEFORE navigating to the success screen.
// Returns only { payment_status, status } — never bypasses Paymob confirmation.
// ══════════════════════════════════════════════════════════════════════════════
router.get('/:id/payment-status', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id, user_id, status, payment_status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Order not found.' });

    // IDOR guard — only the order owner or an elevated role can query this
    const userRole = (req.user?.role || '').toLowerCase();
    const isElevated = ['admin', 'owner', 'reviewer', 'super_admin'].includes(userRole);
    if (data.user_id !== req.user.id && !isElevated) {
      return res.status(403).json({ success: false, message: 'Access denied to this order.' });
    }

    return res.json({
      success: true,
      data: {
        payment_status: data.payment_status,  // 'pending' | 'initiated' | 'paid' | 'failed'
        status: data.status,          // 'pending' | 'confirmed' | etc.
      },
    });
  } catch (err) {
    console.error('❌ [Orders] GET /:id/payment-status Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Durable recovery hook for terminal-order restoration. The ledger in the
// Products database makes this endpoint safe against concurrent staff retries
// and against a process dying after the stock transaction commits.
router.post('/:id/inventory/retry', authenticateToken, checkRole(['admin','super_admin','owner','reviewer']), async(req,res)=>{
  try{
    const {data:order,error}=await supabase.from('orders').select('id,status,stock_status,payment_method,payment_status').eq('id',req.params.id).maybeSingle();
    if(error)throw error;
    if(!order)return res.status(404).json({success:false,message:'Order not found.'});
    if(String(order.payment_method).toLowerCase()==='cod'&&order.status==='pending'){
      if(order.stock_status==='done')return res.json({success:true,inventoryStatus:'done',idempotentReplay:true});
      if(!['pending','processing','failed'].includes(order.stock_status))return res.status(409).json({success:false,message:'COD inventory state is not recoverable.'});
      const {error:claimError}=await supabase.from('orders').update({stock_status:'processing',stock_processing_started_at:new Date().toISOString()})
        .eq('id',order.id).eq('status','pending').in('stock_status',['pending','processing','failed']);
      if(claimError)throw claimError;
      const deduction=await reduceStockForOrder(order.id);
      if(!deduction.success){await supabase.from('orders').update({stock_status:'failed',stock_processing_started_at:null}).eq('id',order.id).eq('stock_status','processing');return res.status(409).json({success:false,inventoryStatus:'failed',message:'COD inventory deduction remains pending and can be retried.'});}
      const {error:doneError}=await supabase.from('orders').update({stock_status:'done',stock_processing_started_at:null}).eq('id',order.id).eq('stock_status','processing');
      if(doneError)return res.status(202).json({success:true,inventoryStatus:'processing',message:'Stock movement is durable; order status finalization will be retried.'});
      return res.json({success:true,inventoryStatus:'done'});
    }
    if(!['cancelled','refunded'].includes(order.status))return res.status(409).json({success:false,message:'Only pending COD orders or cancelled/refunded orders can reconcile inventory.'});
    if(order.stock_status==='restored')return res.json({success:true,inventoryStatus:'restored',idempotentReplay:true});
    if(!['done','processing','failed'].includes(order.stock_status))return res.status(409).json({success:false,message:'No completed stock deduction is available to restore.'});
    const {data:claim,error:claimError}=await supabase.from('orders').update({stock_status:'processing',stock_processing_started_at:new Date().toISOString()})
      .eq('id',order.id).eq('status',order.status).in('stock_status',['done','processing','failed']).select('id');
    if(claimError)throw claimError;
    if(!claim?.length)return res.status(409).json({success:false,message:'Inventory state changed; refresh and retry.'});
    const result=await restoreStockForOrder(order.id);
    if(!result.success){await supabase.from('orders').update({stock_status:'failed',stock_processing_started_at:null}).eq('id',order.id).eq('stock_status','processing');return res.status(409).json({success:false,inventoryStatus:'failed',message:'Stock restoration remains pending and can be retried.'});}
    const {error:finalError}=await supabase.from('orders').update({stock_status:'restored',stock_processing_started_at:null}).eq('id',order.id).eq('status',order.status).eq('stock_status','processing');
    if(finalError)return res.status(202).json({success:true,inventoryStatus:'processing',message:'Stock movement is durable; order status finalization will be retried.'});
    return res.json({success:true,inventoryStatus:'restored'});
  }catch(error){console.error('[Orders] inventory retry failed:',error.message);return res.status(500).json({success:false,message:'Could not reconcile inventory.'});}
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH /api/orders/:id/status  — Update order status (Admin / Super-Admin only)
// Body: { status: string }
// ══════════════════════════════════════════════════════════════════════════════
router.patch('/:id/status', authenticateToken, checkRole(['admin', 'super_admin', 'owner', 'reviewer']), async (req, res) => {
  const { status } = req.body;

  if (!status || !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      success: false,
      message: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  try {
    // Fetch the order first to get the owner's user_id and current stock_status
    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('id, user_id, status, stock_status, payment_status, payment_method')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Skip update if status hasn't changed
    if (order.status === status && !(['cancelled','refunded'].includes(order.status) && order.stock_status === 'done')) {
      return res.json({ success: true, message: 'Status unchanged', data: order });
    }

    // ── Terminal-state guard ───────────────────────────────────────────────
    // Once an order is cancelled or refunded its stock has been restored
    // (stock_status = 'restored'). Re-activating it would leave stock
    // permanently under-counted. Forbid ANY transition out of these states.
    const TERMINAL_CANCEL_STATUSES = ['cancelled', 'refunded'];
    if (TERMINAL_CANCEL_STATUSES.includes(order.status)) {
      return res.status(409).json({
        success: false,
        message: `Order is already "${order.status}" and cannot be moved to "${status}". ` +
                 'Once an order is cancelled or refunded, its status cannot be changed.',
      });
    }
    const paymentBlock=cancellationBlock(order,status);
    if(paymentBlock)return res.status(paymentBlock.status).json({success:false,code:paymentBlock.code,message:paymentBlock.message});
    const transitionBlock=orderStatusTransitionBlock(order,status);
    if(transitionBlock)return res.status(transitionBlock.status).json({success:false,code:transitionBlock.code,message:transitionBlock.message});

    // Update the order status
    const { data: updated, error: updateError } = await supabase
      .from('orders')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('status', order.status)
      .eq('payment_status', order.payment_status)
      .eq('payment_method', order.payment_method)
      .select()
      .single();

    if (updateError) throw updateError;

    // Idempotent stock restore — only when transitioning to cancelled or refunded,
    // and only if stock was actually reduced for this order (stock_status = 'done').
    const terminalCancelStatuses = ['cancelled', 'refunded'];
    if (terminalCancelStatuses.includes(status) && order.stock_status === 'done') {
      const {data:claim}=await supabase.from('orders').update({stock_status:'processing',stock_processing_started_at:new Date().toISOString()}).eq('id',req.params.id).eq('stock_status','done').in('status',['cancelled','refunded']).select('id');
      if(claim?.length){
        const restoreResult = await restoreStockForOrder(req.params.id);
        if (restoreResult.success) {
          await supabase.from('orders').update({ stock_status: 'restored',stock_processing_started_at:null }).eq('id', req.params.id).eq('stock_status','processing');
          console.log(`✅ [Orders] Stock restored for ${status} order ${req.params.id}`);
        } else {
          await supabase.from('orders').update({stock_status:'done',stock_processing_started_at:null}).eq('id',req.params.id).eq('stock_status','processing');
          console.error(`⚠️ [Orders] Stock restore failed for order ${req.params.id}: ${restoreResult.error}`);
        }
      }
    }
    if (terminalCancelStatuses.includes(status)) {
      await transitionOrderReservations({sequelize,orderId:req.params.id,to:'released',from:['consumed','reserved'],reason:`order_${status}`});
    }

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

    return res.json({ success: true, message: `Order status updated to "${status}"`, data: hideInternalOrderCosts(updated) });
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
    // 1️⃣ Fetch the order to verify ownership, status, and current stock_status
    const { data: order, error: fetchErr } = await supabase
      .from('orders')
      .select('id, user_id, status, stock_status, payment_status')
      .eq('id', req.params.id)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found.' });
    }

    // Check ownership (only owner of order can cancel)
    const cancelBlock=customerCancellationBlock(order,userId);
    if(cancelBlock)return res.status(cancelBlock.status).json({success:false,code:cancelBlock.code,message:cancelBlock.message});

    // 2️⃣ Update the order status to cancelled
    const { data: updated, error: updateErr } = await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('status', order.status)
      .eq('payment_status', order.payment_status)
      .in('payment_status', ['pending','initiated','failed'])
      .select('*, order_items(*), shipping_addresses(*)')
      .single();

    if (updateErr) throw updateErr;

    // 3️⃣ Idempotent stock restore — only if stock was actually reduced for this order
    if (order.stock_status === 'done') {
      const {data:claim}=await supabase.from('orders').update({stock_status:'processing',stock_processing_started_at:new Date().toISOString()}).eq('id',req.params.id).eq('stock_status','done').eq('status','cancelled').select('id');
      if(claim?.length){
        const restoreResult = await restoreStockForOrder(req.params.id);
        if(restoreResult.success) await supabase.from('orders').update({stock_status:'restored',stock_processing_started_at:null}).eq('id',req.params.id).eq('stock_status','processing');
        else {
          await supabase.from('orders').update({stock_status:'done',stock_processing_started_at:null}).eq('id',req.params.id).eq('stock_status','processing');
          console.error(`⚠️ [Orders] Stock restore failed for order ${req.params.id}: ${restoreResult.error}`);
        }
      }
    }
    await transitionOrderReservations({sequelize,orderId:req.params.id,to:'released',from:['consumed','reserved'],reason:'customer_cancelled_order'});

    // Log activity
    await logActivity(userId, 'CANCEL_ORDER', 'order', req.params.id, {
      cancelledBy: userId === order.user_id ? 'user' : 'admin',
      previousStatus: order.status
    });

    console.log(`✅ Order ${order.id} was cancelled by user.`);
    return res.json({ success: true, message: 'Order cancelled successfully', data: hideInternalOrderCosts(updated) });
  } catch (err) {
    console.error('❌ Cancel Order Error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
