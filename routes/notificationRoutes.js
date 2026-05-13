const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { sendNotification } = require('../utils/fcmService');

// Endpoint for testing
router.post('/send-test', async (req, res) => {
    const { email, title, body } = req.body;

    try {
        const user = await User.findOne({ where: { email } });

        if (!user) {
            return res.status(404).json({ success: false, message: 'المستخدم مش موجود' });
        }

        if (!user.fcmToken) {
            return res.status(400).json({ success: false, message: 'المستخدم ده معندوش Token' });
        }

        const result = await sendNotification(
            user.fcmToken,
            title || "Test Notification",
            body || "The notification is working properly 🔥",
            { type: 'test_click', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
        );  

        res.json({ success: true, firebaseResponse: result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;