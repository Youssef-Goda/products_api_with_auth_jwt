'use strict';

/**
 * Persist an order and its line items atomically on the Sequelize connection.
 * Product costs are loaded inside that same transaction and client-supplied
 * cost fields are never read.
 */
async function createOrderWithItems({ sequelize, Product, orderData, initialStatus, items, insertOrder, insertItems }) {
  return sequelize.transaction(async (transaction) => {
    const productIds = [...new Set(items.map((item) => item?.product_id).filter(Boolean).map(String))];
    if (productIds.length === 0 || items.some((item) => !item?.product_id)) {
      throw new Error('Every order item must reference a product.');
    }

    const products = await Product.findAll({
      where: { id: productIds },
      attributes: ['id', 'costPrice'],
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    const productById = new Map(products.map((product) => [String(product.id).toLowerCase(), product]));
    if (productIds.some((id) => !productById.has(id.toLowerCase()))) {
      throw new Error('One or more products in this order do not exist.');
    }

    const orderRow = await insertOrder({ transaction, initialStatus, orderData });
    if (!orderRow?.id) throw new Error('Order creation did not return an order ID.');

    const itemsPayload = items.map((item) => {
      const product = productById.get(String(item.product_id).toLowerCase());
      return {
        order_id: orderRow.id,
        product_id: item.product_id,
        product_name: item.product_name,
        product_code: item.product_code ?? null,
        image_url: item.image_url ?? null,
        unit_price: item.unit_price,
        quantity: item.quantity,
        subtotal: item.subtotal,
        unit_cost_snapshot: product.costPrice == null ? null : Number(product.costPrice),
      };
    });

    await insertItems({ transaction, orderId: orderRow.id, items: itemsPayload });
    return { orderRow, itemsPayload };
  });
}

module.exports = { createOrderWithItems };
