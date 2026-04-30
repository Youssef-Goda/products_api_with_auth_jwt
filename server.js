require('dotenv').config();
require('pg'); // إجبار السيرفر على استدعاء المكتبة في أول ثانية
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const userRoutes = require('./routes/userRoutes');
const cartRoutes = require('./routes/cartRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
// const { authenticateToken } = require('./middlewares/authMiddleware');
const sequelize = require('./config/database');

// ── Ensure Sequelize is aware of Cart models so sync() registers them ──
require('./models/Cart');
require('./models/CartEvent');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());

// ── Static files: serve uploaded images publicly ──────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ربط الرّوتات
app.use('/api/auth', authRoutes);
app.use('/api/products', /*authenticateToken,*/ productRoutes);
app.use('/api/users', userRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/uploads', uploadRoutes);

const PORT = process.env.PORT || 5000;

// التعديل هنا: شلنا alter عشان نحمي الداتا في الـ Production
// لو غيرت في الموديل مستقبلاً، اعمل التغيير في سوبابيز يدوي أو استخدم Migrations
sequelize.sync()
  .then(() => {
    console.log('✅ Database connected and synced!');
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('❌ Database connection error:', err);
  });