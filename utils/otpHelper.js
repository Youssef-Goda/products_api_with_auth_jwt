const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./mydb.sqlite');

// إنشاء جدول OTP لو مش موجود
db.run(`
  CREATE TABLE IF NOT EXISTS otps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER,
    otp TEXT,
    createdAt INTEGER,
    expiry INTEGER,
    FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
  )
`);

// توليد OTP جديد وتخزينه
function generateOtp(userId) {
  return new Promise((resolve, reject) => {
    const now = Date.now();

    // نجيب آخر OTP
    db.get(
      `SELECT * FROM otps WHERE userId = ? ORDER BY id DESC LIMIT 1`,
      [userId],
      (err, row) => {
        if (err) return reject(err);

        // لو فيه OTP ولسه ماعدتش دقيقة من وقت إنشاؤه → متبعتش تاني
        if (row && now - row.createdAt < 60 * 1000) {
          return reject(new Error('OTP already sent recently'));
        }

        const otp = ('' + Math.floor(100000 + Math.random() * 900000)); // 6 أرقام
        const expiry = now + 5 * 60 * 1000; // 5 دقايق

        db.run(
          `INSERT INTO otps (userId, otp, createdAt, expiry) VALUES (?, ?, ?, ?)`,
          [userId, otp, now, expiry],
          function (err) {
            if (err) return reject(err);
            resolve(otp);
          }
        );
      }
    );
  });
}

// التحقق من OTP
function verifyOtp(userId, otp) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM otps WHERE userId = ? AND otp = ?`,
      [userId, otp],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(false);

        // OTP منتهي
        if (Date.now() > row.expiry) {
          db.run(`DELETE FROM otps WHERE id = ?`, [row.id]);
          return resolve(false);
        }

        // ✅ OTP صحيح → امسح كل الأكواد للمستخدم + فعل الحساب
        db.run(`DELETE FROM otps WHERE userId = ?`, [userId]);
        db.run(`UPDATE users SET isVerified = 1 WHERE id = ?`, [userId]);

        return resolve(true);
      }
    );
  });
}

module.exports = { generateOtp, verifyOtp };
