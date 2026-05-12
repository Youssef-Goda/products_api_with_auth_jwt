/**
 * fcmService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firebase Admin SDK initialisation + helper functions for push notifications.
 *
 * SETUP:
 *  1. Download your Firebase service account JSON from:
 *     Firebase Console → Project Settings → Service Accounts → Generate new key
 *  2. Save it as  config/firebase-service-account.json  (already git-ignored).
 *  3. Add  GOOGLE_APPLICATION_CREDENTIALS=./config/firebase-service-account.json
 *     to your .env  –OR–  set FIREBASE_SERVICE_ACCOUNT_JSON to the raw JSON string
 *     (preferred for production / Vercel where you can't ship files).
 */

const admin = require('firebase-admin');

// ── Initialise once ──────────────────────────────────────────────────────────
if (!admin.apps.length) {
  let credential;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    // Production: JSON injected as an env-var string
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      credential = admin.credential.cert(serviceAccount);
    } catch (e) {
      console.error('❌ FCM: Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
    }
  } else {
    // Local dev: JSON file on disk (path from env or default)
    const path = require('path');
    const keyPath =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      path.join(__dirname, '../config/firebase-service-account.json');
    try {
      credential = admin.credential.cert(require(keyPath));
    } catch (e) {
      console.warn(
        '⚠️  FCM: Could not load service-account file from',
        keyPath,
        '– push notifications will be disabled.',
      );
    }
  }

  if (credential) {
    admin.initializeApp({ credential });
    console.log('✅ Firebase Admin SDK initialised');
  }
}

// ── Core send function ───────────────────────────────────────────────────────

/**
 * Send a push notification to a single FCM token.
 *
 * @param {string} fcmToken   - Device FCM registration token
 * @param {string} title      - Notification title
 * @param {string} body       - Notification body text
 * @param {Object} [data={}]  - Optional key-value data payload (string values only)
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
async function sendNotification(fcmToken, title, body, data = {}) {
  if (!admin.apps.length) {
    return { success: false, error: 'Firebase Admin not initialised' };
  }
  if (!fcmToken) {
    return { success: false, error: 'No FCM token provided' };
  }

  // Stringify all data values (FCM requirement)
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const message = {
    token: fcmToken,
    notification: { title, body },
    data: stringData,
    android: {
      priority: 'high',
      notification: { sound: 'default', channelId: 'dealio_orders' },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1 } },
    },
  };

  try {
    const messageId = await admin.messaging().send(message);
    console.log(`✅ FCM notification sent (${messageId}) → ${fcmToken.slice(0, 20)}…`);
    return { success: true, messageId };
  } catch (err) {
    console.error('❌ FCM send error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send a push notification to multiple FCM tokens in one batch (up to 500).
 *
 * @param {string[]} fcmTokens
 * @param {string}   title
 * @param {string}   body
 * @param {Object}   [data={}]
 * @returns {Promise<admin.messaging.BatchResponse|null>}
 */
async function sendMulticastNotification(fcmTokens, title, body, data = {}) {
  if (!admin.apps.length) {
    console.error('❌ Firebase Admin not initialised');
    return null;
  }
  if (!fcmTokens || fcmTokens.length === 0) {
    return null;
  }

  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const message = {
    tokens: fcmTokens,
    notification: { title, body },
    data: stringData,
    android: {
      priority: 'high',
      notification: { sound: 'default', channelId: 'dealio_orders' },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1 } },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`✅ FCM multicast: ${response.successCount} sent, ${response.failureCount} failed`);
    return response;
  } catch (err) {
    console.error('❌ FCM multicast error:', err.message);
    return null;
  }
}

module.exports = { sendNotification, sendMulticastNotification };
