const express = require('express');
const bcrypt = require('bcryptjs');
const sequelize = require('../config/database'); // السطر ده المتصلح
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
        if (existingUser) return res.status(400).json({ status: 'error', message: 'Email already exists' });

        await PendingUser.destroy({ where: { email } });
        const hashedPassword = await bcrypt.hash(password, 10);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await PendingUser.create({
            firstName, lastName, email, password: hashedPassword,
            otp, otpExpiry: Date.now() + 5 * 60 * 1000
        });

        await sendOTP(email, otp, 'verify'); 
        res.status(200).json({ status: 'success', message: 'OTP Sent', email });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
});

// // 2. ========================= Verify OTP (Register) =========================
// router.post('/verify-otp', async (req, res) => {
//     const { email, otp } = req.body;
//     const t = await sequelize.transaction();
//     try {
//         const pendingUser = await PendingUser.findOne({ where: { email } }, { transaction: t });
//         if (!pendingUser || pendingUser.otp !== otp || Date.now() > pendingUser.otpExpiry) {
//             await t.rollback();
//             return res.status(400).json({ status: 'error', message: 'Invalid or expired OTP' });
//         }

//         const newUser = await User.create({
//             firstName: pendingUser.firstName,
//             lastName: pendingUser.lastName,
//             email: pendingUser.email,
//             password: pendingUser.password
//         }, { transaction: t });

//         const accessToken = generateAccessToken(newUser);
//         const refreshToken = generateRefreshToken(newUser);
//         newUser.refreshToken = refreshToken;
//         await newUser.save({ transaction: t });
//         await pendingUser.destroy({ transaction: t });

//         await t.commit();
//         sendOTP(newUser.email, '', 'welcome').catch(e => console.log("Welcome Email Error"));

//         res.json({ 
//             status: 'success', accessToken, refreshToken, 
//             user: { id: newUser.id, firstName: newUser.firstName, lastName: newUser.lastName, email: newUser.email } 
//         });
//     } catch (err) {
//         if (t) await t.rollback();
//         res.status(500).json({ status: 'error', message: 'Server error' });
//     }
// });


// 2. ========================= Verify OTP (Register) =========================
router.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const t = await sequelize.transaction();
    try {
        const pendingUser = await PendingUser.findOne({ where: { email } }, { transaction: t });
        
        if (!pendingUser || pendingUser.otp !== otp || Date.now() > pendingUser.otpExpiry) {
            await t.rollback();
            return res.status(400).json({ status: 'error', message: 'Invalid or expired OTP' });
        }

        const newUser = await User.create({
            firstName: pendingUser.firstName,
            lastName: pendingUser.lastName,
            email: pendingUser.email,
            password: pendingUser.password
        }, { transaction: t });

        const accessToken = generateAccessToken(newUser);
        const refreshToken = generateRefreshToken(newUser);
        newUser.refreshToken = refreshToken;
        
        await newUser.save({ transaction: t });
        await pendingUser.destroy({ transaction: t });

        // لازم الـ commit يحصل قبل إرسال الإيميل عشان نضمن إن البيانات اتحفظت
        await t.commit();

        // التعديل الجوهري هنا: زودنا await
        // كدة السيرفر هيستنى الإيميل يخرج لـ Brevo قبل ما يرد على فلاتر
        try {
            await sendOTP(newUser.email, '', 'welcome');
            console.log("✅ Welcome Email Sent Successfully");
        } catch (e) {
            console.log("⚠️ Welcome Email Error (but user is verified):", e.message);
        }

        // الرد على فلاتر هو آخر خطوة خالص
        res.json({ 
            status: 'success', 
            accessToken, 
            refreshToken, 
            user: { id: newUser.id, firstName: newUser.firstName, lastName: newUser.lastName, email: newUser.email } 
        });

    } catch (err) {
        // لو حصل خطأ والـ Transaction لسه مفتوحة، اقفلها
        if (t && !t.finished) await t.rollback();
        console.error("❌ Verify Error:", err);
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});



// 3. ========================= Login =========================
router.post('/login', async (req, res) => {
    const { email, password } = req.body; 
    try {
        const user = await User.findOne({ where: { email } });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
        }

        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);
        user.refreshToken = refreshToken;
        await user.save();

        res.json({ 
            status: 'success', accessToken, refreshToken, 
            user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email } 
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

// 4. ========================= Forgot Password =========================
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const user = await User.findOne({ where: { email } });
        if (!user) return res.status(404).json({ status: 'error', message: 'Email not found' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await sendOTP(email, otp, 'reset'); 

        user.resetOtp = otp;
        user.resetOtpExpiry = Date.now() + 10 * 60 * 1000;
        await user.save();

        res.json({ status: 'success', message: 'Reset OTP sent' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

// 5. ========================= Reset Password =========================
router.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const user = await User.findOne({ where: { email, resetOtp: otp } });
        if (!user || user.resetOtp !== otp || Date.now() > user.resetOtpExpiry) {
            return res.status(400).json({ status: 'error', message: 'Invalid or expired OTP' });
        }

        const isSamePassword = await bcrypt.compare(newPassword, user.password);
        if (isSamePassword) return res.status(400).json({ status: 'error', message: 'New password cannot be the same as old' });

        user.password = await bcrypt.hash(newPassword, 10);
        user.resetOtp = null;
        user.resetOtpExpiry = null;

        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user);
        user.refreshToken = refreshToken;
        await user.save();

        sendOTP(email, '', 'reset_success').catch(e => console.log("Confirmation Email Error"));

        res.json({ 
            status: 'success', accessToken, refreshToken,
            user: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

// 6. ========================= Resend OTP =========================
router.post('/send-otp', async (req, res) => {
    const { email } = req.body;
    try {
        // بنشوف هل اليوزر لسه في قائمة الانتظار (مأكدش حسابه)؟
        const pendingUser = await PendingUser.findOne({ where: { email } });
        if (!pendingUser) {
            return res.status(404).json({ status: 'error', message: 'No pending registration found' });
        }

        // توليد كود جديد وتحديث الوقت
        const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
        pendingUser.otp = newOtp;
        pendingUser.otpExpiry = Date.now() + 5 * 60 * 1000; // 5 دقائق
        await pendingUser.save();

        // إرسال الإيميل
        await sendOTP(email, newOtp, 'verify');

        res.json({ status: 'success', message: 'New OTP sent to your email' });
    } catch (err) {
        console.error("Resend OTP Error:", err);
        res.status(500).json({ status: 'error', message: 'Internal server error' });
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
        res.json({ status: 'success', message: 'Logged out' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

module.exports = router;