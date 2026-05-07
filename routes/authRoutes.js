const express = require('express');
const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const User = require('../models/User');
const PendingUser = require('../models/PendingUser');
const { generateAccessToken, generateRefreshToken } = require('../utils/generateTokens');
const { sendOTP } = require('../utils/otpHelper');
const router = express.Router();

// 1. ========================= Register =========================
router.post('/register', async (req, res) => {
    const { firstName, lastName, email, password } = req.body;
    try {
        const existingUser = await User.findOne({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Email already exists' });
        }

        await PendingUser.destroy({ where: { email } });
        const hashedPassword = await bcrypt.hash(password, 10);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await PendingUser.create({
            firstName, lastName, email, password: hashedPassword,
            otp, otpExpiry: Date.now() + 5 * 60 * 1000
        });

        await sendOTP(email, otp, 'verify');
        res.status(200).json({ success: true, message: 'OTP Sent', email });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 2. ========================= Verify OTP (Register) =========================
router.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const t = await sequelize.transaction();
    try {
        const pendingUser = await PendingUser.findOne({ where: { email } }, { transaction: t });

        if (!pendingUser || pendingUser.otp !== otp || Date.now() > pendingUser.otpExpiry) {
            await t.rollback();
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        const newUser = await User.create({
            firstName: pendingUser.firstName,
            lastName: pendingUser.lastName,
            email: pendingUser.email,
            password: pendingUser.password,
            role: 'user'
        }, { transaction: t });

        const accessToken = generateAccessToken(newUser);
        const refreshToken = generateRefreshToken(newUser);
        newUser.refreshToken = refreshToken;

        await newUser.save({ transaction: t });
        await pendingUser.destroy({ transaction: t });

        await t.commit();

        try {
            await sendOTP(newUser.email, '', 'welcome');
            console.log("✅ Welcome Email Sent Successfully");
        } catch (e) {
            console.log("⚠️ Welcome Email Error (but user is verified):", e.message);
        }

        res.json({
            user: {
                id: newUser.id, firstName: newUser.firstName, lastName: newUser.lastName, email: newUser.email,
                phoneNumber: newUser.phoneNumber, birthDate: newUser.birthDate, gender: newUser.gender, profilePicture: newUser.profilePicture
            }
        });

    } catch (err) {
        if (t && !t.finished) await t.rollback();
        console.error("❌ Verify Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 3. ========================= Login =========================
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ where: { email } });

        // Google User Guard: email exists but password is NULL (Google sign-up)
        if (user && user.password === null) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }

        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);
        user.refreshToken = refreshToken;
        await user.save();

        res.json({
            success: true, accessToken, refreshToken,
            user: {
                id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email,
                phoneNumber: user.phoneNumber, birthDate: user.birthDate, gender: user.gender, profilePicture: user.profilePicture
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 4. ========================= Forgot Password =========================
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ where: { email } });
        if (!user) {
            return res.status(404).json({ success: false, message: "Email doesn't exist" });
        }

        // Google User Guard: email exists but password is NULL (Google sign-up)
        if (user.password === null) {
            return res.status(400).json({ success: false, message: 'Invalid request' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await sendOTP(email, otp, 'reset');

        user.resetOtp = otp;
        user.resetOtpExpiry = Date.now() + 10 * 60 * 1000;
        await user.save();

        res.json({ success: true, message: 'Reset OTP sent' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 5. ========================= Reset Password =========================
router.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const user = await User.findOne({ where: { email, resetOtp: otp } });
        if (!user || user.resetOtp !== otp || Date.now() > user.resetOtpExpiry) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }

        const isSamePassword = await bcrypt.compare(newPassword, user.password);
        if (isSamePassword) {
            return res.status(400).json({ success: false, message: 'New password cannot be the same as old' });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        user.resetOtp = null;
        user.resetOtpExpiry = null;

        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);
        user.refreshToken = refreshToken;
        await user.save();

        sendOTP(email, '', 'reset_success').catch(e => console.log("Confirmation Email Error"));

        res.json({
            success: true, accessToken, refreshToken,
            user: {
                id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email,
                phoneNumber: user.phoneNumber, birthDate: user.birthDate, gender: user.gender, profilePicture: user.profilePicture
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 6. ========================= Resend OTP =========================
router.post('/send-otp', async (req, res) => {
    const { email } = req.body;
    try {
        const pendingUser = await PendingUser.findOne({ where: { email } });
        if (!pendingUser) {
            return res.status(404).json({ success: false, message: 'No pending registration found' });
        }

        const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
        pendingUser.otp = newOtp;
        pendingUser.otpExpiry = Date.now() + 5 * 60 * 1000;
        await pendingUser.save();

        await sendOTP(email, newOtp, 'verify');

        res.json({ success: true, message: 'New OTP sent to your email' });
    } catch (err) {
        console.error("Resend OTP Error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// 7. ========================= Logout =========================
router.post('/logout', async (req, res) => {
    const { refreshToken } = req.body;
    try {
        const user = await User.findOne({ where: { refreshToken } });
        if (user) {
            user.refreshToken = null;
            await user.save();
        }
        res.json({ success: true, message: 'Logged out' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// 8. ========================= Verify Reset OTP =========================
router.post('/verify-reset-otp', async (req, res) => {
    const { email, otp } = req.body;
    try {
        const user = await User.findOne({ where: { email, resetOtp: otp } });
        if (!user || Date.now() > user.resetOtpExpiry) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }
        res.json({ success: true, message: 'OTP is valid' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;