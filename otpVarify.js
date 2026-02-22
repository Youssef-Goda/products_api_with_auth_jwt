app.post('/verify-otp', async (req, res) => {
    const { email, otp } = req.body;

    try {
        // 1. هات الكود الموجود في الداتا بيز عشان نقارنه
        const [rows] = await db.query(
            "SELECT otp, otp_expiry FROM users WHERE email = ?",
            [email]
        );
        const user = rows[0];

        if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });

        // 2. التحقق من الوقت والكود
        const now = new Date();
        if (user.otp !== otp || now > new Date(user.otp_expiry)) {
            return res.status(400).json({ status: 'error', message: 'Invalid or expired OTP' });
        }

        // 3. تفعيل الحساب ومسح الكود (Update)
        await db.query(
            "UPDATE users SET otp = NULL, otp_expiry = NULL, isVerified = 1 WHERE email = ?",
            [email]
        );

        // ---------------------------------------------------------
        // التعديل الجديد: إرسال إيميل الترحيب
        // بنحطه في try-catch لوحده عشان لو "قدر الله" الإيميل فشل، اليوزر ميتعطلش
        try {
            // استيراد الدالة لو مش موجودة في الملف ده
            // const { sendOTP } = require('./utils/otpHelper'); 
            
            await sendOTP(email, null, 'welcome');
            console.log(`✅ Welcome email sent to: ${email}`);
        } catch (mailErr) {
            console.error("⚠️ Welcome email failed to send, but user is verified:", mailErr.message);
            // لاحظ مبعتناش Error هنا عشان العملية تكمل عادي
        }
        // ---------------------------------------------------------

        // 4. جيب بيانات اليوزر "بعد التحديث" عشان نبعتها لفلاتر كاملة
        const [updatedRows] = await db.query(
            "SELECT id, firstName, lastName, email FROM users WHERE email = ?",
            [email]
        );
        const userData = updatedRows[0];

        // 5. الرد النهائي والوحيد للدالة
        res.json({ 
            status: 'success', 
            message: 'OTP verified successfully!',
            user: userData 
        });

    } catch (err) {
        console.error("❌ Global Verify Error:", err);
        res.status(500).json({ status: 'error', message: 'Error verifying OTP' });
    }
});