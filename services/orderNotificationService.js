/**
 * orderNotificationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Business-logic layer: maps order status changes → user push notifications.
 *
 * Usage (in your order update controller / route):
 *
 *   const { notifyOrderStatusChanged } = require('../services/orderNotificationService');
 *   // After successfully updating an order:
 *   await notifyOrderStatusChanged(orderId, newStatus, userId);
 */

const User = require('../models/User');
const { sendNotification } = require('../utils/fcmService');

// Human-readable labels for each order status
const STATUS_MESSAGES = {
  pending:    { title: '⏳ Order Received',    body: 'Your order #{id} has been placed and is awaiting confirmation.' },
  confirmed:  { title: '✅ Order Confirmed',   body: 'Great news! Your order #{id} has been confirmed.' },
  processing: { title: '📦 Order Processing',  body: 'Your order #{id} is now being prepared.' },
  shipped:    { title: '🚚 Order Shipped',      body: 'Your order #{id} is on its way! Track it in the app.' },
  delivered:  { title: '🎉 Order Delivered',   body: 'Your order #{id} has been delivered. Enjoy your purchase!' },
  cancelled:  { title: '❌ Order Cancelled',   body: 'Your order #{id} has been cancelled. Contact support if needed.' },
  refunded:   { title: '💰 Refund Processed',  body: 'A refund for order #{id} has been processed.' },
};

/**
 * Sends a push notification to the user whose order status changed.
 *
 * @param {string|number} orderId   - The order ID (used in the message body)
 * @param {string}        newStatus - One of the keys in STATUS_MESSAGES
 * @param {string}        userId    - UUID of the user who owns the order
 * @returns {Promise<void>}
 */
async function notifyOrderStatusChanged(orderId, newStatus, userId) {
  try {
    const template = STATUS_MESSAGES[newStatus];
    if (!template) {
      console.warn(`⚠️  orderNotificationService: Unknown status "${newStatus}" — skipping notification`);
      return;
    }

    // Fetch the user's FCM token from the DB
    const user = await User.findByPk(userId, { attributes: ['id', 'fcmToken'] });
    if (!user) {
      console.warn(`⚠️  orderNotificationService: User ${userId} not found`);
      return;
    }
    if (!user.fcmToken) {
      console.log(`ℹ️  orderNotificationService: User ${userId} has no FCM token — skip`);
      return;
    }

    const shortId = String(orderId).slice(0, 8).toUpperCase();
    const title = template.title;
    const body  = template.body.replace('#{id}', `#${shortId}`);

    await sendNotification(user.fcmToken, title, body, {
      type:    'order_status',
      orderId: String(orderId),
      status:  newStatus,
    });
  } catch (err) {
    // Never let notification errors crash the main request
    console.error('❌ orderNotificationService error:', err.message);
  }
}

module.exports = { notifyOrderStatusChanged };
