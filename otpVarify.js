// app.post('/verify-otp', async (req, res) => {
//     const { email, otp } = req.body;

//     try {
//         const [rows] = await db.query(
//             "SELECT otp, otp_expiry FROM users WHERE email = ?",
//             [email]
//         );
//         const user = rows[0];

//         if (!user) return res.status(404).json({ message: 'User not found' });

//         // التحقق من الوقت والكود
//         const now = new Date();
//         if (user.otp !== otp || now > new Date(user.otp_expiry)) {
//             return res.status(400).json({ message: 'Invalid or expired OTP' });
//         }

//         // تفعيل الحساب ومسح الكود
//         await db.query(
//             "UPDATE users SET otp = NULL, otp_expiry = NULL, isVerified = 1 WHERE email = ?",
//             [email]
//         );

//         res.json({ message: 'OTP verified successfully!' });
//     } catch (err) {
//         res.status(500).json({ message: 'Error verifying OTP' });
//     }
// });

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

        // 4. جيب بيانات اليوزر "بعد التحديث" عشان نبعتها لفلاتر كاملة
        const [updatedRows] = await db.query(
            "SELECT id, firstName, lastName, email FROM users WHERE email = ?",
            [email]
        );
        const userData = updatedRows[0];

        // 5. الرد النهائي والوحيد للدالة (وده اللي فلاتر مستنيه)
        res.json({ 
            status: 'success', 
            message: 'OTP verified successfully!',
            user: userData 
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ status: 'error', message: 'Error verifying OTP' });
    }
});