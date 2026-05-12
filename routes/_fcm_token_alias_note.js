// ══════════════════════════════════════════════════════════════════════════════
// PUT /update-fcm-token  (alias kept for Flutter client compatibility)
// This route is appended to userRoutes.js — add it just before module.exports
// ══════════════════════════════════════════════════════════════════════════════
//
// NOTE: The canonical endpoint is already at PUT /fcm-token (line 414 of userRoutes.js).
// The alias below is added so the Flutter client can POST to /users/update-fcm-token
// matching the plan's spec without changing existing behaviour.
//
// ADD this block at the bottom of userRoutes.js (before module.exports):
//
// router.post('/update-fcm-token', authenticateToken, async (req, res) => {
//   try {
//     const { fcmToken } = req.body;
//     if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
//       return res.status(400).json({ success: false, message: 'fcmToken is required.' });
//     }
//     const user = await User.findByPk(req.user.id);
//     if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
//     await user.update({ fcmToken: fcmToken.trim() });
//     console.log(`✅ FCM token updated (POST alias) for user ${req.user.id}`);
//     return res.json({ success: true, message: 'FCM token saved successfully.' });
//   } catch (err) {
//     console.error('❌ FCM Token Update Error:', err);
//     return res.status(500).json({ success: false, message: err.message });
//   }
// });
