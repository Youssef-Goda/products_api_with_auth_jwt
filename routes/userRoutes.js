const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const sequelize = require('../config/database');
const User = require('../models/User');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { checkRole, ownerPrivilege } = require('../middlewares/checkRole');
const { sendOTP } = require('../utils/otpHelper');
const { logActivity } = require('../services/activityLogger');

// ── Multer: memory storage (no disk writes) ─────────────────────────────────
const _upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'Only JPG/PNG/WebP files are allowed.'));
  },
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// ── GET / ── Get all users (Admin / Super-Admin only)
router.get('/', authenticateToken, checkRole(['admin', 'super_admin']), async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: [
        'id', 'serial_id', 'code', 'firstName', 'lastName', 'email',
        'role', 'isActive', 'phoneNumber', 'birthDate', 'gender',
        'profilePicture', 'createdAt', 'updatedAt'
      ],
      order: [['serial_id', 'DESC']]
    });
    console.log(`✅ Successfully fetched ${users.length} users`);
    res.json(users);
  } catch (err) {
    console.error('❌ Database Error Details:', err.message);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ── DELETE /:id ── Delete user (Super-Admin only)
router.delete('/:id', authenticateToken, checkRole(['super_admin']), async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const userEmail = user.email;
    const result = await User.destroy({ where: { id: req.params.id } });
    if (result) {
      await logActivity(req.user.id, 'DELETE_USER', 'user', req.params.id, { email: userEmail });
      res.json({ success: true, message: 'User deleted successfully' });
    } else {
      res.status(404).json({ success: false, message: 'User not found' });
    }
  } catch (err) {
    console.error('❌ Delete Error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// Only admin or owner may change roles.
// ownerPrivilege prevents non-owners from modifying owner accounts.
router.put('/update-role/:id', authenticateToken, checkRole(['admin', 'owner']), ownerPrivilege, async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ['user', 'customer', 'vendor', 'moderator', 'admin', 'owner'];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
    }

    // Admins cannot promote anyone to owner
    if (role === 'owner' && req.user.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only the Owner can promote users to Owner.' });
    }

    const targetUser = await User.findByPk(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    // Peer-admin protection: admins cannot modify another admin's role
    if (req.user.role === 'admin') {
      const targetRole = (targetUser.role || '').toLowerCase();
      if (targetRole === 'admin' || targetRole === 'owner') {
        return res.status(403).json({ success: false, message: 'Admins cannot modify the role of another Admin or Owner.' });
      }
    }

    const oldRole = targetUser.role;
    await User.update({ role }, { where: { id: req.params.id } });

    // Log activity
    await logActivity(req.user.id, 'UPDATE_USER_ROLE', 'user', req.params.id, {
      email: targetUser.email,
      oldRole,
      newRole: role
    });

    res.json({ success: true, message: 'Role updated successfully' });
  } catch (err) {
    console.error('❌ Update Role Error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ── PUT /toggle-status/:id ── Toggle account status (Admin / Super-Admin only)
router.put('/toggle-status/:id', authenticateToken, checkRole(['admin', 'super_admin']), async (req, res) => {
  try {
    const { isActive } = req.body;
    const targetUser = await User.findByPk(req.params.id);
    if (!targetUser) return res.status(404).json({ success: false, message: 'User not found' });

    await User.update({ isActive }, { where: { id: req.params.id } });

    // Log activity
    await logActivity(req.user.id, 'TOGGLE_USER_STATUS', 'user', req.params.id, {
      email: targetUser.email,
      isActive
    });

    res.json({ success: true, message: 'Account status updated' });
  } catch (err) {
    console.error('❌ Toggle Error:', err);
    res.status(500).json({ error: 'Failed to update account status' });
  }
});

// ══════════════════════════════════════════════════════════
// ── GET /profile ── Get own profile (Authenticated)
// ══════════════════════════════════════════════════════════
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: [
        'id', 'firstName', 'lastName', 'email', 'phoneNumber',
        'birthDate', 'gender', 'profilePicture', 'role', 'isActive'
      ]
    });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.json({ success: true, data: { user } });
  } catch (err) {
    console.error('❌ Fetch Profile Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// ── PUT /profile ── Update own profile (Authenticated)
// ══════════════════════════════════════════════════════════
router.put('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { firstName, lastName, phoneNumber, birthDate, gender, profilePicture } = req.body;

    const allowedUpdates = {};
    if (firstName !== undefined) allowedUpdates.firstName = firstName;
    if (lastName !== undefined) allowedUpdates.lastName = lastName;
    if (phoneNumber !== undefined) allowedUpdates.phoneNumber = phoneNumber;
    if (birthDate !== undefined) allowedUpdates.birthDate = birthDate;
    if (gender !== undefined) {
      const validGenders = ['male', 'female', 'other'];
      if (!validGenders.includes(gender)) {
        return res.status(400).json({ success: false, message: "Gender must be 'male', 'female', or 'other'" });
      }
      allowedUpdates.gender = gender;
    }
    if (profilePicture !== undefined) allowedUpdates.profilePicture = profilePicture;

    await user.update(allowedUpdates);

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          birthDate: user.birthDate,
          gender: user.gender,
          profilePicture: user.profilePicture
        }
      }
    });
  } catch (err) {
    console.error('❌ Profile Update Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── POST /profile/picture ── Upload & save profile picture (Authenticated)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/users/profile/picture
 * Body: multipart/form-data, field name: "image" (JPG/PNG/WebP, max 5 MB)
 * 1. Multer buffers the file in memory
 * 2. Forwards to ImgBB → gets a permanent public URL
 * 3. Saves the URL to users.profilePicture
 * 4. Returns { success, data: { user: { ...all profile fields... } } }
 */
router.post('/profile/picture', authenticateToken, (req, res) => {
  _upload.single('image')(req, res, async (err) => {
    // ── Multer errors ──────────────────────────────────────────────────────
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large. Maximum 5 MB.' });
      }
      return res.status(400).json({ success: false, message: err.field ?? 'Only JPG/PNG/WebP files are allowed.' });
    }
    if (err) {
      console.error('❌ Upload middleware error:', err);
      return res.status(500).json({ success: false, message: 'File upload failed.' });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image provided. Send the file under field name "image".' });
    }

    // ── Forward to ImgBB ───────────────────────────────────────────────────
    const apiKey = process.env.IMGBB_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, message: 'Server configuration error: ImgBB API key missing.' });
    }

    try {
      const form = new FormData();
      form.append('image', req.file.buffer, {
        filename: req.file.originalname || 'avatar.jpg',
        contentType: req.file.mimetype,
      });

      const imgbbRes = await axios.post(
        `https://api.imgbb.com/1/upload?key=${apiKey}`,
        form,
        { headers: form.getHeaders(), timeout: 30_000 }
      );

      const imgbbData = imgbbRes.data?.data;
      const imageUrl = imgbbData?.display_url ?? imgbbData?.url;
      if (!imageUrl) {
        return res.status(502).json({ success: false, message: 'ImgBB did not return a valid URL.' });
      }

      // ── Persist URL to DB ─────────────────────────────────────────────────
      const user = await User.findByPk(req.user.id);
      if (!user) return res.status(404).json({ success: false, message: 'User not found' });

      await user.update({ profilePicture: imageUrl });

      console.log(`✅ Profile picture updated for user ${req.user.id}: ${imageUrl}`);
      return res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            email: user.email,
            phoneNumber: user.phoneNumber,
            birthDate: user.birthDate,
            gender: user.gender,
            profilePicture: user.profilePicture,
            role: user.role,
            isActive: user.isActive,
          }
        }
      });
    } catch (imgbbErr) {
      const status = imgbbErr.response?.status;
      const detail = imgbbErr.response?.data?.error?.message ?? imgbbErr.message;
      console.error(`❌ ImgBB error (${status}):`, detail);
      return res.status(502).json({ success: false, message: `Image upload failed: ${detail}` });
    }
  });
});

// ══════════════════════════════════════════════════════════
// EMAIL CHANGE FLOW (3-step, high-security)
// ══════════════════════════════════════════════════════════

/**
 * STEP 1 — Verify identity (password OR OTP fallback on current email)
 * POST /api/users/change-email/verify-identity
 * Body: { method: 'password' | 'otp', password?: string, otp?: string }
 */
router.post('/change-email/verify-identity', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const { method, password, otp } = req.body;

    if (method === 'password') {
      // Password-based identity verification
      if (!password) return res.status(400).json({ success: false, message: 'Password is required' });
      if (!user.password) {
        return res.status(400).json({ success: false, message: 'This account uses social login. Use OTP method instead.' });
      }
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) return res.status(401).json({ success: false, message: 'Incorrect password' });

    } else if (method === 'otp') {
      // OTP fallback: verify the OTP sent to current (old) email
      if (!otp) return res.status(400).json({ success: false, message: 'OTP is required' });
      if (!user.resetOtp || user.resetOtp !== otp || Date.now() > user.resetOtpExpiry) {
        return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
      }
      // Clear the used reset OTP
      user.resetOtp = null;
      user.resetOtpExpiry = null;

    } else {
      return res.status(400).json({ success: false, message: "method must be 'password' or 'otp'" });
    }

    // Mark identity as verified (gate for step 2)
    user.emailChangeVerified = true;
    await user.save();

    res.json({ success: true, message: 'Identity verified. You may now provide a new email.' });
  } catch (err) {
    console.error('❌ Verify Identity Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * STEP 1b — Send OTP to current email (for OTP fallback method)
 * POST /api/users/change-email/send-identity-otp
 */
router.post('/change-email/send-identity-otp', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetOtp = otp;
    user.resetOtpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
    await user.save();

    await sendOTP(user.email, otp, 'reset');
    res.json({ success: true, message: `OTP sent to your current email (${user.email})` });
  } catch (err) {
    console.error('❌ Send Identity OTP Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * STEP 2 — Provide new email → sends OTP to new email
 * POST /api/users/change-email/send-otp
 * Body: { newEmail: string }
 */
router.post('/change-email/send-otp', authenticateToken, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Must have completed step 1
    if (!user.emailChangeVerified) {
      return res.status(403).json({ success: false, message: 'Identity not verified. Complete step 1 first.' });
    }

    const { newEmail } = req.body;
    if (!newEmail) return res.status(400).json({ success: false, message: 'New email is required' });
    if (newEmail === user.email) {
      return res.status(400).json({ success: false, message: 'New email must be different from current email' });
    }

    // Check if new email is already taken
    const conflict = await User.findOne({ where: { email: newEmail } });
    if (conflict) return res.status(409).json({ success: false, message: 'Email dosn\'t exist' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    user.pendingEmail = newEmail;
    user.emailChangeOtp = otp;
    user.emailChangeOtpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
    await user.save();

    await sendOTP(newEmail, otp, 'verification');
    res.json({ success: true, message: `Verification code sent to ${newEmail}` });
  } catch (err) {
    console.error('❌ Send New Email OTP Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * STEP 3 — Confirm OTP received at new email → update email in DB
 * POST /api/users/change-email/confirm
 * Body: { otp: string }
 */
router.post('/change-email/confirm', authenticateToken, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const user = await User.findByPk(req.user.id, { transaction: t });
    if (!user) {
      await t.rollback();
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.emailChangeVerified || !user.pendingEmail) {
      await t.rollback();
      return res.status(403).json({ success: false, message: 'Email change flow not initiated properly' });
    }

    const { otp } = req.body;
    if (!otp) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'OTP is required' });
    }

    if (user.emailChangeOtp !== otp || Date.now() > user.emailChangeOtpExpiry) {
      await t.rollback();
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    const newEmail = user.pendingEmail;

    // Final conflict check (inside transaction)
    const conflict = await User.findOne({ where: { email: newEmail }, transaction: t });
    if (conflict && conflict.id !== user.id) {
      await t.rollback();
      return res.status(409).json({ success: false, message: 'Email dosn\'t exist' });
    }

    // Atomically update the email and clear all flow fields
    await user.update({
      email: newEmail,
      pendingEmail: null,
      emailChangeOtp: null,
      emailChangeOtpExpiry: null,
      emailChangeVerified: false
    }, { transaction: t });

    await t.commit();

    res.json({
      success: true,
      message: 'Email updated successfully',
      data: { email: newEmail }
    });
  } catch (err) {
    if (t && !t.finished) await t.rollback();
    console.error('❌ Confirm Email Change Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// \u2500\u2500 PUT /fcm-token \u2500\u2500 Save / refresh FCM push token (Authenticated)
// Body: { fcmToken: string }
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
router.put('/fcm-token', authenticateToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
      return res.status(400).json({ success: false, message: 'fcmToken is required and must be a non-empty string.' });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    await user.update({ fcmToken: fcmToken.trim() });

    console.log(`\u2705 FCM token updated for user ${req.user.id}`);
    return res.json({ success: true, message: 'FCM token saved successfully.' });
  } catch (err) {
    console.error('\u274c FCM Token Update Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── POST /update-fcm-token ── Flutter-compatible alias (Authenticated)
// Body: { fcmToken: string }
// ══════════════════════════════════════════════════════════════════════════════
router.post('/update-fcm-token', authenticateToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim() === '') {
      return res.status(400).json({ success: false, message: 'fcmToken is required and must be a non-empty string.' });
    }

    const user = await User.findByPk(req.user.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

    await user.update({ fcmToken: fcmToken.trim() });

    console.log(`✅ FCM token updated for user ${req.user.id}`);
    return res.json({ success: true, message: 'FCM token saved successfully.' });
  } catch (err) {
    console.error('❌ FCM Token Update Error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;