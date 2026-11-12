'use strict';

const { createClient } = require('@supabase/supabase-js');
const { Op } = require('sequelize');
const Product = require('../models/Product');
const sequelize = require('../config/database');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function aggregateOrderItems(items) {
  const grouped = new Map();
  for (const item of items) {
    const productId = String(item.product_id);
    const quantity = Number.parseInt(item.quantity, 10);
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error(`Invalid quantity for product ${productId}.`);
    const row = grouped.get(productId) || { productId, quantity: 0, name: item.product_name || productId };
    row.quantity += quantity;
    if (!Number.isSafeInteger(row.quantity)) throw new Error(`Invalid aggregate quantity for product ${productId}.`);
    grouped.set(productId, row);
  }
  return [...grouped.values()].sort((a, b) => a.productId.localeCompare(b.productId));
}

async function getOrderItems(orderId) {
  const { data, error } = await supabase.from('order_items').select('product_id,product_name,quantity').eq('order_id', orderId);
  if (error) throw new Error(`Failed to fetch order items: ${error.message}`);
  if (!data?.length) throw new Error(`No order items found for order ${orderId}`);
  return aggregateOrderItems(data);
}

// Ledger claim and inventory mutation commit on the same Sequelize connection.
// A lost HTTP response is safe: retry observes the committed unique ledger row.
async function applyMovement(orderId, action, items) {
  const transaction = await sequelize.transaction();
  try {
    for (const { productId, quantity, name } of items) {
      if (action === 'restore') {
        const [deductionRows] = await sequelize.query(
          `SELECT quantity FROM public.inventory_stock_movements
           WHERE order_id=:orderId AND product_id=:productId AND action='deduct' FOR UPDATE`,
          { transaction, replacements: { orderId, productId } },
        );
        const deduction=deductionRows?.[0];
        if (!deduction || Number(deduction.quantity) !== quantity) throw new Error(`No matching deduction movement for ${productId}.`);
      }

      const [claimed] = await sequelize.query(
        `INSERT INTO public.inventory_stock_movements(order_id,product_id,action,quantity)
         VALUES(:orderId,:productId,:action,:quantity)
         ON CONFLICT(order_id,product_id,action) DO NOTHING RETURNING id`,
        { transaction, replacements: { orderId, productId, action, quantity } },
      );
      if (!claimed?.length) {
        const [existingRows] = await sequelize.query(
          `SELECT quantity FROM public.inventory_stock_movements
           WHERE order_id=:orderId AND product_id=:productId AND action=:action`,
          { transaction, replacements: { orderId, productId, action } },
        );
        const existing=existingRows?.[0];
        if (!existing || Number(existing.quantity) !== quantity) throw new Error(`Inventory movement quantity mismatch for ${productId}.`);
        continue;
      }

      const decrement = action === 'deduct';
      const [affected] = await Product.update(
        { countInStock: sequelize.literal(`"countInStock" ${decrement ? '-' : '+'} ${quantity}`) },
        { where: { id: productId, ...(decrement ? { countInStock: { [Op.gte]: quantity } } : {}) }, transaction },
      );
      if (affected !== 1) throw new Error(decrement
        ? `Insufficient stock for product "${name}" (${productId}).`
        : `Failed to restore stock for product "${name}" (${productId}).`);
    }
    await transaction.commit();
    return { success: true };
  } catch (error) {
    try { await transaction.rollback(); } catch (rollbackError) { console.error('[stockService] rollback failed:', rollbackError.message); }
    console.error(`[stockService.${action}] transaction rolled back for ${orderId}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function reduceStockForOrder(orderId) {
  try { return await applyMovement(orderId, 'deduct', await getOrderItems(orderId)); }
  catch (error) { return { success: false, error: error.message }; }
}

async function restoreStockForOrder(orderId) {
  try { return await applyMovement(orderId, 'restore', await getOrderItems(orderId)); }
  catch (error) { return { success: false, error: error.message }; }
}

module.exports = { reduceStockForOrder, restoreStockForOrder, aggregateOrderItems };
