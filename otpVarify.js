app.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  const [rows] = await db.query(
    "SELECT otp, otp_expiry FROM users WHERE email = ?",
    [email]
  );
  const user = rows[0];

  if (!user) return res.status(404).json({ message: 'User not found' });

  const now = new Date();
  if (user.otp !== otp || now > user.otp_expiry) {
    return res.status(400).json({ message: 'Invalid or expired OTP' });
  }

  // ✅ تحديث حالة التفعيل + مسح الـ OTP بعد نجاح التحقق
  await db.query(
    "UPDATE users SET otp = NULL, otp_expiry = NULL, isVerified = 1 WHERE email = ?",
    [email]
  );

  res.json({ message: 'OTP verified successfully' });
});
