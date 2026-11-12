'use strict';

/**
 * Persist an order and its line items atomically on the Sequelize connection.
 * Product costs are loaded inside that same transaction and client-supplied
 * cost fields are never read.
 */
async function createOrderWithItems({ sequelize, Product, orderData, initialStatus, items, insertOrder, insertItems, prepareOrder, idempotencyKey, userId }) {
  return sequelize.transaction(async (transaction) => {
    if (idempotencyKey) {
      const existing = await sequelize.query('SELECT * FROM public.orders WHERE user_id=:userId AND checkout_idempotency_key=:idempotencyKey FOR UPDATE', {
        type: require('sequelize').QueryTypes.SELECT, transaction, replacements: { userId, idempotencyKey },
      });
      if (existing[0]) return { orderRow: existing[0], itemsPayload: [], duplicate: true, pricing: null };
    }
    const pricing = prepareOrder ? await prepareOrder({ transaction }) : null;
    const sourceItems = pricing ? pricing.items.map((item) => ({
      product_id: item.productId, product_name: item.productName, product_code: item.productCode,
      image_url: item.imageUrl, unit_price: item.unitPrice, quantity: item.quantity,
      subtotal: item.effectiveSubtotal, original_subtotal: item.originalSubtotal,
      discount_amount: item.discountAmount, effective_unit_price: item.effectiveUnitPrice,
      applied_promotion_ids: item.promotionIds, promotion_names: item.promotionNames,
    })) : items;
    if (!Array.isArray(sourceItems) || sourceItems.length === 0 || sourceItems.some((item) => !item?.product_id)) {
      throw new Error('Every order item must reference a product.');
    }

    const productIds = [...new Set(sourceItems.map((item) => String(item.product_id)))];
    const products = await Product.findAll({
      where: { id: productIds },
      attributes: ['id', 'costPrice'],
      order: [['id','ASC']],
      transaction,
      lock: transaction.LOCK?.UPDATE,
    });
    const productById = new Map(products.map((product) => [String(product.id).toLowerCase(), product]));
    if (productIds.some((id) => !productById.has(id.toLowerCase()))) {
      throw new Error('One or more products in this order do not exist.');
    }

    const finalOrderData = pricing ? {
      ...orderData,
      subtotal: pricing.subtotal,
      original_subtotal: pricing.originalSubtotal,
      tax: pricing.tax,
      total: pricing.total,
      discount_total: pricing.discountTotal,
      coupon_code: pricing.couponCode,
      applied_promotion_ids: [...new Set(pricing.promotions.map((promotion) => promotion.id))],
      promotion_names: [...new Set(pricing.promotions.map((promotion) => promotion.name))],
      checkout_idempotency_key: idempotencyKey,
    } : orderData;
    const orderRow = await insertOrder({ transaction, initialStatus, orderData: finalOrderData });
    if (!orderRow?.id) throw new Error('Order creation did not return an order ID.');

    const itemsPayload = sourceItems.map((item) => {
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
        ...(pricing ? {
          original_subtotal: item.original_subtotal,
          discount_amount: item.discount_amount,
          effective_unit_price: item.effective_unit_price,
          applied_promotion_ids: item.applied_promotion_ids,
          promotion_names: item.promotion_names,
        } : {}),
        unit_cost_snapshot: product.costPrice == null ? null : Number(product.costPrice),
      };
    });

    await insertItems({ transaction, orderId: orderRow.id, items: itemsPayload });
    if (pricing) {
      const redemptionStatus = orderData.payment_method === 'cod' ? 'consumed' : 'reserved';
      for (const reservation of pricing.reservations) {
        await sequelize.query(`INSERT INTO promotion_redemptions(promotion_id,customer_id,order_id,status,discount_amount,expires_at)
          VALUES(:promotionId,:customerId,:orderId,:status,:discountAmount,CASE WHEN :status='reserved' THEN now()+interval '30 minutes' ELSE NULL END)`, {
          transaction, replacements: { promotionId: reservation.promotionId, customerId: userId, orderId: orderRow.id, status: redemptionStatus, discountAmount: reservation.discountAmount },
        });
        await sequelize.query('INSERT INTO promotion_audit_logs(promotion_id,actor_id,action,details) VALUES(:promotionId,:actorId,:action,CAST(:details AS jsonb))', {
          transaction, replacements: { promotionId: reservation.promotionId, actorId: userId, action: redemptionStatus === 'consumed' ? 'redemption_consumed' : 'redemption_reserved', details: JSON.stringify({ orderId: orderRow.id, discountAmount: reservation.discountAmount }) },
        });
      }
    }
    return { orderRow, itemsPayload, pricing };
  });
}

module.exports = { createOrderWithItems };
