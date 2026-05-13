/**
 * fcmService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Firebase Admin SDK initialisation + helper functions for push notifications.
 */

const admin = require('firebase-admin');

// ── Initialise once ──────────────────────────────────────────────────────────
if (!admin.apps.length) {
  let credential;

  // 1. بص في فيرسال (Environment Variable)
  const envConfig = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;

  if (envConfig) {
    try {
      const serviceAccount = JSON.parse(envConfig);
      // تصحيح للـ Private Key لو فيه مشكلة في الـ New Lines في فيرسال
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      credential = admin.credential.cert(serviceAccount);
      console.log('✅ FCM: Initialised via Environment Variable (Vercel)');
    } catch (e) {
      console.error('❌ FCM: Failed to parse Environment Variable:', e.message);
    }
  } else {
    // 2. لو مش على فيرسال، بص على جهازك (Local dev)
    const path = require('path');
    const keyPath =
      process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      path.join(__dirname, '../config/dealio-eg7-firebase-adminsdk-fbsvc-9325784312.json');

    try {
      credential = admin.credential.cert(require(keyPath));
      console.log('✅ FCM: Initialised via Local JSON file');
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
    console.log('🚀 Firebase Admin SDK initialised successfully');
  }
}

// ── Core send function ───────────────────────────────────────────────────────

/**
 * Send a push notification to a single FCM token.
 */
async function sendNotification(fcmToken, title, body, data = {}) {
  if (!admin.apps.length) {
    return { success: false, error: 'Firebase Admin not initialised' };
  }
  if (!fcmToken) {
    return { success: false, error: 'No FCM token provided' };
  }

  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, String(v)])
  );

  const message = {
    token: fcmToken,
    notification: { title, body },
    data: stringData,
    android: {
      priority: 'high',
      notification: { 
        sound: 'default', 
        channelId: 'dealio_orders',
        icon: 'ic_notification', // لازم يطابق اسم الملف في drawable
        color: '#FFD700',        // لون الخلفية اللي طلبته (الدهبي)
        clickAction: 'FLUTTER_NOTIFICATION_CLICK'
      },
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
 * Send a push notification to multiple FCM tokens.
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
      notification: { 
        sound: 'default', 
        channelId: 'dealio_orders',
        icon: 'ic_notification', // لازم يطابق اسم الملف في drawable
        color: '#FFD700',        // لون الخلفية اللي طلبته (الدهبي)
        clickAction: 'FLUTTER_NOTIFICATION_CLICK'
      },
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