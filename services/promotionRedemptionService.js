'use strict';

const { QueryTypes } = require('sequelize');

async function transitionOrderReservations({ sequelize, orderId, from = ['reserved'], to, reason }) {
  if (!['consumed','released','expired'].includes(to)) throw new TypeError('Invalid redemption state transition.');
  return sequelize.transaction(async (transaction) => {
    const rows = await sequelize.query(`UPDATE promotion_redemptions SET status=:to,
      expires_at=CASE WHEN :to='consumed' THEN NULL ELSE expires_at END,updated_at=now()
      WHERE order_id=:orderId AND status IN (:from) RETURNING promotion_id,customer_id,discount_amount`, {
      type: QueryTypes.SELECT, transaction, replacements: { orderId, from, to },
    });
    const updated = Array.isArray(rows) ? rows : [];
    for (const row of updated) {
      await sequelize.query(`INSERT INTO promotion_audit_logs(promotion_id,actor_id,action,details)
        VALUES(:promotionId,:actorId,:action,CAST(:details AS jsonb))`, {
        transaction, replacements: {
          promotionId: row.promotion_id, actorId: row.customer_id,
          action: `redemption_${to}`,
          details: JSON.stringify({ orderId, discountAmount: row.discount_amount, reason: reason || null }),
        },
      });
    }
    return updated;
  });
}

module.exports = { transitionOrderReservations };
