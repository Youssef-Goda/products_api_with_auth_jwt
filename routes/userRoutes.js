const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const User = require('../models/User');
const { authenticateToken } = require('../middlewares/authMiddleware');
const { sendOTP } = require('../utils/otpHelper');

// ── GET / ── Get all users (Admin)
router.get('/', async (req, res) => {
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

// ── DELETE /:id ── Delete user (Admin)
router.delete('/:id', async (req, res) => {
  try {
    const result = await User.destroy({ where: { id: req.params.id } });
    if (result) {
      res.json({ success: true, message: 'User deleted successfully' });
    } else {
      res.status(404).json({ success: false, message: 'User not found' });
    }
  } catch (err) {
    console.error('❌ Delete Error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ── PUT /update-role/:id ── Update role (Admin)
router.put('/update-role/:id', async (req, res) => {
  try {
    const { role } = req.body;
    await User.update({ role }, { where: { id: req.params.id } });
    res.json({ success: true, message: 'Role updated successfully' });
  } catch (err) {
    console.error('❌ Update Role Error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// ── PUT /toggle-status/:id ── Toggle account status (Admin)
router.put('/toggle-status/:id', async (req, res) => {
  try {
    const { isActive } = req.body;
    await User.update({ isActive }, { where: { id: req.params.id } });
    res.json({ success: true, message: 'Account status updated' });
  } catch (err) {
    console.error('❌ Toggle Error:', err);
    res.status(500).json({ error: 'Failed to update account status' });
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
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        phoneNumber: user.phoneNumber,
        birthDate: user.birthDate,
        gender: user.gender,
        profilePicture: user.profilePicture
      }
    });
  } catch (err) {
    console.error('❌ Profile Update Error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
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
    if (conflict) return res.status(409).json({ success: false, message: 'Email already in use by another account' });

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
      return res.status(409).json({ success: false, message: 'Email already in use by another account' });
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

module.exports = router;