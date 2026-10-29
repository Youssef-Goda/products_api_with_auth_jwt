'use strict';
/**
 * stockService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared stock reduction / restoration logic.
 *
 * Used by:
 *   • COD order creation  (routes/orderRoutes.js  POST /)
 *   • User cancel         (routes/orderRoutes.js  POST /:id/cancel)
 *   • Admin status change (routes/orderRoutes.js  PATCH /:id/status)
 *   • Paymob webhook      (controllers/paymobController.js)
 *
 * Both functions operate on the Sequelize-managed "Products" table.
 * The orders.stock_status column (Supabase/PostgREST) is updated by the
 * CALLER after these functions return, keeping the two DB connections decoupled.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { createClient } = require('@supabase/supabase-js');
const { Op }           = require('sequelize');
const Product          = require('../models/Product');
const sequelize        = require('../config/database');

// Supabase admin client (read order_items — bypass RLS)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ══════════════════════════════════════════════════════════════════════════════
// reduceStockForOrder
//
// Atomically decrements "Products"."countInStock" for every item in an order.
// Uses a Sequelize transaction: ALL decrements commit together or ALL roll back.
//
// Each decrement uses a conditional UPDATE:
//   UPDATE "Products"
//   SET    "countInStock" = "countInStock" - qty
//   WHERE  id = productId
//     AND  "countInStock" >= qty
//
// If the WHERE condition fails (insufficient stock or missing product),
// 0 rows are affected → the entire transaction rolls back.
//
// Returns: { success: true } | { success: false, error: string }
// ══════════════════════════════════════════════════════════════════════════════
async function reduceStockForOrder(orderId) {
  // 1. Fetch order items from Supabase
  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('product_id, product_name, quantity')
    .eq('order_id', orderId);

  if (itemsErr) {
    return { success: false, error: `Failed to fetch order items: ${itemsErr.message}` };
  }
  if (!items || items.length === 0) {
    return { success: false, error: `No order items found for order ${orderId}` };
  }

  console.log(
    `📦 [stockService.reduce] Processing ${items.length} item(s) for order ${orderId}`
  );

  // 2. Validate all quantities before entering the transaction
  for (const item of items) {
    const qty = parseInt(item.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      return {
        success: false,
        error: `Invalid quantity for product ${item.product_id}: "${item.quantity}"`,
      };
    }
  }

  // 3. Sequelize transaction: atomic conditional decrement for every product
  const t = await sequelize.transaction();
  try {
    for (const item of items) {
      const qty       = parseInt(item.quantity, 10);
      const productId = item.product_id;
      const name      = item.product_name ?? productId;

      // Conditional decrement: only proceeds if stock >= qty
      const [affectedCount] = await Product.update(
        { countInStock: sequelize.literal(`"countInStock" - ${qty}`) },
        {
          where: {
            id:           productId,
            countInStock: { [Op.gte]: qty },
          },
          transaction: t,
        }
      );

      if (affectedCount !== 1) {
        throw new Error(
          `Insufficient stock for product "${name}" (id=${productId}): ` +
          `need ${qty} unit(s) but available stock is less than that, ` +
          `or product does not exist.`
        );
      }

      console.log(
        `✅ [stockService.reduce] Product "${name}" (${productId}) − ${qty} unit(s)`
      );
    }

    await t.commit();
    console.log(
      `✅ [stockService.reduce] All ${items.length} product(s) decremented for order ${orderId}`
    );
    return { success: true };

  } catch (txErr) {
    try { await t.rollback(); } catch (rbErr) {
      console.error(
        `❌ [stockService.reduce] Rollback also failed for order ${orderId}: ${rbErr.message}`
      );
    }
    console.error(
      `❌ [stockService.reduce] Transaction rolled back for order ${orderId}: ${txErr.message}`
    );
    return { success: false, error: txErr.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// restoreStockForOrder
//
// Unconditionally increments "Products"."countInStock" for every item in an order.
// Mirror of reduceStockForOrder — also uses a Sequelize transaction.
//
// The increment has NO lower-bound guard (no WHERE on countInStock) because we
// are restoring stock that was previously confirmed to have been reduced.
// The CALLER is responsible for calling this only when stock_status = 'done'.
//
// Returns: { success: true } | { success: false, error: string }
// ══════════════════════════════════════════════════════════════════════════════
async function restoreStockForOrder(orderId) {
  // 1. Fetch order items from Supabase
  const { data: items, error: itemsErr } = await supabase
    .from('order_items')
    .select('product_id, product_name, quantity')
    .eq('order_id', orderId);

  if (itemsErr) {
    return { success: false, error: `Failed to fetch order items: ${itemsErr.message}` };
  }
  if (!items || items.length === 0) {
    return { success: false, error: `No order items found for order ${orderId}` };
  }

  console.log(
    `📦 [stockService.restore] Processing ${items.length} item(s) for order ${orderId}`
  );

  // 2. Validate quantities
  for (const item of items) {
    const qty = parseInt(item.quantity, 10);
    if (!Number.isInteger(qty) || qty < 1) {
      return {
        success: false,
        error: `Invalid quantity for product ${item.product_id}: "${item.quantity}"`,
      };
    }
  }

  // 3. Sequelize transaction: unconditional increment for every product
  const t = await sequelize.transaction();
  try {
    for (const item of items) {
      const qty       = parseInt(item.quantity, 10);
      const productId = item.product_id;
      const name      = item.product_name ?? productId;

      // Unconditional increment — no WHERE guard on countInStock
      const [affectedCount] = await Product.update(
        { countInStock: sequelize.literal(`"countInStock" + ${qty}`) },
        {
          where: { id: productId },
          transaction: t,
        }
      );

      if (affectedCount !== 1) {
        throw new Error(
          `Failed to restore stock for product "${name}" (id=${productId}): ` +
          `product may no longer exist.`
        );
      }

      console.log(
        `✅ [stockService.restore] Product "${name}" (${productId}) + ${qty} unit(s)`
      );
    }

    await t.commit();
    console.log(
      `✅ [stockService.restore] All ${items.length} product(s) restored for order ${orderId}`
    );
    return { success: true };

  } catch (txErr) {
    try { await t.rollback(); } catch (rbErr) {
      console.error(
        `❌ [stockService.restore] Rollback also failed for order ${orderId}: ${rbErr.message}`
      );
    }
    console.error(
      `❌ [stockService.restore] Transaction rolled back for order ${orderId}: ${txErr.message}`
    );
    return { success: false, error: txErr.message };
  }
}

module.exports = { reduceStockForOrder, restoreStockForOrder };

