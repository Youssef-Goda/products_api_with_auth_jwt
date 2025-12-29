require('pg'); // إجبار السيرفر على استدعاء المكتبة في أول ثانية
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors'); // 1. استيراد مكتبة الـ CORS
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const userRoutes = require('./routes/userRoutes');
const { authenticateToken } = require('./middlewares/authMiddleware');
const sequelize = require('./config/database');

dotenv.config();
const app = express();

// 2. تفعيل الـ CORS (هذا السطر هو مفتاح حل مشكلة الويب)
app.use(cors()); 

app.use(express.json());

// ربط الرّوتات
app.use('/api/auth', authRoutes);
app.use('/api/products', authenticateToken, productRoutes);
app.use('/api/users', userRoutes);

const PORT = process.env.PORT || 5000;

// 

sequelize.sync({ alter: true }) 
  .then(() => {
    console.log('Database synced safely!');
    // '0.0.0.0' ممتازة عشان الموبايل والويب يشوفوا السيرفر
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌐 Local Web Access: http://localhost:${PORT}`);
    });
  })
  .catch(err => console.error('Error syncing database:', err));