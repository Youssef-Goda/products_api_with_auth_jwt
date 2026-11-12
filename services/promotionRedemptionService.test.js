'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transitionOrderReservations } = require('./promotionRedemptionService');

function fixture() {
  const committed = { reservations: [{ promotion_id: 'promotion-a', customer_id: 'customer-a', discount_amount: '10.00' }], audit: [] };
  const sequelize = {
    async transaction(callback) {
      const staged = structuredClone(committed);
      const result = await callback({ staged });
      committed.reservations = staged.reservations;
      committed.audit = staged.audit;
      return result;
    },
    async query(sql, options) {
      if (sql.includes('UPDATE promotion_redemptions')) {
        const { orderId, from, to } = options.replacements;
        const reservation = options.transaction.staged.reservations[0];
        if (orderId !== 'order-a' || !from.includes(reservation.status || 'reserved')) return [];
        reservation.status = to;
        if (to === 'consumed') reservation.expires_at = null;
        return [{ ...reservation }];
      }
      if (sql.includes('INSERT INTO promotion_audit_logs')) options.transaction.staged.audit.push(options.replacements);
      return [];
    },
  };
  return { sequelize, committed };
}

test('Paymob success consumes a reservation once and clears its expiry', async () => {
  const f = fixture();
  const first = await transitionOrderReservations({ sequelize: f.sequelize, orderId: 'order-a', to: 'consumed', reason: 'verified success' });
  const duplicate = await transitionOrderReservations({ sequelize: f.sequelize, orderId: 'order-a', to: 'consumed' });
  assert.equal(first.length, 1);
  assert.equal(duplicate.length, 0);
  assert.equal(f.committed.reservations[0].status, 'consumed');
  assert.equal(f.committed.reservations[0].expires_at, null);
  assert.equal(f.committed.audit.length, 1);
});

test('failed or cancelled payment releases a reserved coupon only once', async () => {
  const f = fixture();
  const released = await transitionOrderReservations({ sequelize: f.sequelize, orderId: 'order-a', to: 'released', reason: 'payment failed' });
  const duplicate = await transitionOrderReservations({ sequelize: f.sequelize, orderId: 'order-a', to: 'released' });
  assert.equal(released.length, 1);
  assert.equal(duplicate.length, 0);
  assert.equal(f.committed.reservations[0].status, 'released');
  assert.equal(f.committed.audit.length, 1);
});
