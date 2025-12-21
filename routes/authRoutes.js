// const express = require('express');
// const bcrypt = require('bcryptjs');
// const jwt = require('jsonwebtoken');
// const { Op } = require('sequelize');
// const sequelize = require('../config/database');
// const User = require('../models/User');
// const PendingUser = require('../models/PendingUser');
// const { generateAccessToken, generateRefreshToken } = require('../utils/generateTokens');
// const { sendOTP } = require('../mailer');

// const router = express.Router();

// // 1. ========================= Register =========================
// router.post('/register', async (req, res) => {
//     const { username, email, password } = req.body;
    
//     if (!username || !email || !password) {
//         return res.status(400).json({ status: 'error', message: 'All fields are required' });
//     }

//     try {
//         const existingUsername = await User.findOne({ where: { username } });
//         if (existingUsername) {
//             return res.status(400).json({ status: 'error', message: 'This username  already taken' });
//         }

//         const existingEmail = await User.findOne({ where: { email } });
//         if (existingEmail) {
//             return res.status(400).json({ status: 'error', message: 'This email is already registered' });
//         }

//         await PendingUser.cleanupExisting(username, email);
//         const hashedPassword = await bcrypt.hash(password, 10);
//         const otp = Math.floor(100000 + Math.random() * 900000).toString();
//         const otpExpiry = Date.now() + 5 * 60 * 1000;

//         await PendingUser.create({
//             username,
//             email,
//             password: hashedPassword,
//             otp,
//             otpExpiry
//         });

//         await sendOTP(email, otp);
//         res.status(201).json({ status: 'success', message: `OTP sent to ${email}`, email });

//     } catch (err) {
//         console.error(err);
//         res.status(500).json({ status: 'error', message: 'Internal Server Error' });
//     }
// });

// // 2. ========================= Verify OTP (Register) =========================
// router.post('/verify-otp', async (req, res) => {
//     const { email, otp } = req.body;
//     if (!email || !otp) {
//         return res.status(400).json({ status: 'error', message: 'Email and OTP are required' });
//     }

//     const t = await sequelize.transaction();
//     try {
//         const pendingUser = await PendingUser.findOne({ where: { email } }, { transaction: t });
        
//         if (!pendingUser) {
//             await t.rollback();
//             return res.status(404).json({ status: 'error', message: 'No pending account found' });
//         }

//         if (Date.now() > pendingUser.otpExpiry) {
//             await pendingUser.destroy({ transaction: t });
//             await t.commit();
//             return res.status(400).json({ status: 'error', message: 'OTP expired. Please register again.' });
//         }

//         if (pendingUser.otp !== otp) {
//             await t.rollback();
//             return res.status(400).json({ status: 'error', message: 'Invalid OTP' });
//         }

//         const newUser = await User.create({
//             username: pendingUser.username,
//             email: pendingUser.email,
//             password: pendingUser.password
//         }, { transaction: t });

//         const accessToken = generateAccessToken(newUser);
//         const refreshToken = generateRefreshToken(newUser);
        
//         newUser.refreshToken = refreshToken;
//         await newUser.save({ transaction: t });
//         await pendingUser.destroy({ transaction: t });

//         await t.commit();
//         res.json({ status: 'success', message: 'Account verified successfully', accessToken, refreshToken, user: { id: newUser.id, username: newUser.username, email: newUser.email } });
//     } catch (err) {
//         await t.rollback();
//         res.status(500).json({ status: 'error', message: 'Server error during verification' });
//     }
// });

// // 3. ========================= Login =========================
// router.post('/login', async (req, res) => {
//     const { usernameOrEmail, password } = req.body;
//     try {
//         const user = await User.findOne({
//             where: { [Op.or]: [{ username: usernameOrEmail }, { email: usernameOrEmail }] }
//         });

//         if (!user || !(await bcrypt.compare(password, user.password))) {
//             return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
//         }

//         const accessToken = generateAccessToken(user);
//         const refreshToken = generateRefreshToken(user);
//         user.refreshToken = refreshToken;
//         await user.save();

//         res.json({ status: 'success', accessToken, refreshToken, user: { id: user.id, username: user.username, email: user.email } });
//     } catch (err) {
//         res.status(500).json({ status: 'error', message: 'Server error' });
//     }
// });

// // 4. ========================= Forgot Password =========================
// router.post('/forgot-password', async (req, res) => {
//     const { email } = req.body;
//     try {
//         const user = await User.findOne({ where: { email } });
//         if (!user) return res.status(404).json({ status: 'error', message: 'Email not found' });

//         const otp = Math.floor(100000 + Math.random() * 900000).toString();
//         const otpExpiry = Date.now() + 10 * 60 * 1000;

//         user.resetOtp = otp;
//         user.resetOtpExpiry = otpExpiry;
//         await user.save();

//         await sendOTP(email, otp);
//         res.json({ status: 'success', message: 'Reset OTP sent to your email' });
//     } catch (err) {
//         res.status(500).json({ status: 'error', message: 'Server error' });
//     }
// });

// // 5. ========================= Reset Password =========================
// router.post('/reset-password', async (req, res) => {
//     const { email, otp, newPassword } = req.body;
//     try {
//         const user = await User.findOne({ where: { email, resetOtp: otp } });

//         if (!user || Date.now() > user.resetOtpExpiry) {
//             return res.status(400).json({ status: 'error', message: 'Invalid or expired OTP' });
//         }

//         user.password = await bcrypt.hash(newPassword, 10);
//         user.resetOtp = null;
//         user.resetOtpExpiry = null;
//         await user.save();

//         res.json({ status: 'success', message: 'Password reset successfully' });
//     } catch (err) {
//         res.status(500).json({ status: 'error', message: 'Server error' });
//     }
// });

// // 6. ========================= Check Availability =========================
// router.post('/check-availability', async (req, res) => {
//     const { type, value } = req.body;
//     try {
//         let user;
//         if (type === 'username') user = await User.findOne({ where: { username: value } });
//         else if (type === 'email') user = await User.findOne({ where: { email: value } });

//         res.json({ status: 'success', isTaken: !!user });
//     } catch (err) {
//         res.status(500).json({ status: 'error', message: 'Server error' });
//     }
// });

// // 7. ========================= Logout =========================
// router.post('/logout', async (req, res) => {
//     const { refreshToken } = req.body;
//     try {
//         const user = await User.findOne({ where: { refreshToken } });
//         if (user) {
//             user.refreshToken = null;
//             await user.save();
//         }
//         res.json({ status: 'success', message: 'Logged out successfully' });
//     } catch (err) {
//         res.status(500).json({ status: 'error', message: 'Server error' });
//     }
// });

// module.exports = router;



const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const sequelize = require('../config/database');
const User = require('../models/User');
const PendingUser = require('../models/PendingUser');
const { generateAccessToken, generateRefreshToken } = require('../utils/generateTokens');
const { sendOTP } = require('../mailer');

const router = express.Router();

// 1. ========================= Register =========================
router.post('/register', async (req, res) => {
    // شلنا username وضفنا firstName و lastName
    const { firstName, lastName, email, password } = req.body;
    
    if (!firstName || !lastName || !email || !password) {
        return res.status(400).json({ status: 'error', message: 'All fields are required' });
    }

    try {
        // شلنا فحص الـ Username وخلينا فحص الإيميل فقط
        const existingEmail = await User.findOne({ where: { email } });
        if (existingEmail) {
            return res.status(400).json({ status: 'error', message: 'This email is already registered' });
        }

        // تنظيف المحاولات المعلقة القديمة لهذا الإيميل
        await PendingUser.cleanupExisting(null, email); 

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry = Date.now() + 5 * 60 * 1000;

        // محاولة إرسال الإيميل أولاً للتأكد من صحته
        try {
            await sendOTP(email, otp);
        } catch (mailError) {
            return res.status(400).json({ status: 'error', message: 'Invalid email or delivery failed' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        // تخزين البيانات مؤقتاً لحين التفعيل (تأكد من تعديل موديل PendingUser أيضاً)
        await PendingUser.create({
            firstName, // تأكد من إضافة هذه الحقول في موديل PendingUser
            lastName,
            email,
            password: hashedPassword,
            otp,
            otpExpiry
        });

        res.status(201).json({ status: 'success', message: `OTP sent to ${email}`, email });

    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error', message: 'Internal Server Error' });
    }
});

// 2. ========================= Verify OTP (Register) =========================
router.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) {
        return res.status(400).json({ status: 'error', message: 'Email and OTP are required' });
    }

    const t = await sequelize.transaction();
    try {
        const pendingUser = await PendingUser.findOne({ where: { email } }, { transaction: t });
        
        if (!pendingUser) {
            await t.rollback();
            return res.status(404).json({ status: 'error', message: 'No pending account found' });
        }

        if (Date.now() > pendingUser.otpExpiry) {
            await pendingUser.destroy({ transaction: t });
            await t.commit();
            return res.status(400).json({ status: 'error', message: 'OTP expired. Please register again.' });
        }

        if (pendingUser.otp !== otp) {
            await t.rollback();
            return res.status(400).json({ status: 'error', message: 'Invalid OTP' });
        }

        // إنشاء المستخدم النهائي بالحقول الجديدة
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

        await t.commit();
        res.json({ 
            status: 'success', 
            message: 'Account verified successfully', 
            accessToken, 
            refreshToken, 
            user: { id: newUser.id, firstName: newUser.firstName, lastName: newUser.lastName, email: newUser.email } 
        });
    } catch (err) {
        await t.rollback();
        console.error(err);
        res.status(500).json({ status: 'error', message: 'Server error during verification' });
    }
});

// 3. ========================= Login =========================
router.post('/login', async (req, res) => {
    // الـ Login الآن يعتمد على الإيميل فقط
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
            status: 'success', 
            accessToken, 
            refreshToken, 
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
        const otpExpiry = Date.now() + 10 * 60 * 1000;

        try {
            await sendOTP(email, otp);
            user.resetOtp = otp;
            user.resetOtpExpiry = otpExpiry;
            await user.save();
            res.json({ status: 'success', message: 'Reset OTP sent to your email' });
        } catch (mailErr) {
            return res.status(400).json({ status: 'error', message: 'Could not send email' });
        }
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

// 5. ========================= Reset Password =========================
router.post('/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const user = await User.findOne({ where: { email, resetOtp: otp } });

        if (!user || Date.now() > user.resetOtpExpiry) {
            return res.status(400).json({ status: 'error', message: 'Invalid or expired OTP' });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        user.resetOtp = null;
        user.resetOtpExpiry = null;
        await user.save();

        res.json({ status: 'success', message: 'Password reset successfully' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

// 6. ========================= Check Email Availability =========================
router.post('/check-availability', async (req, res) => {
    const { value } = req.body; // شلنا الـ type لأننا بنفحص الإيميل بس
    try {
        const user = await User.findOne({ where: { email: value } });
        res.json({ status: 'success', isTaken: !!user });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Server error' });
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
        res.json({ status: 'success', message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

module.exports = router;