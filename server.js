const express = require('express');
const dotenv = require('dotenv');
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const userRoutes = require('./routes/userRoutes'); // استيراد روت المستخدمين
const { authenticateToken } = require('./middlewares/authMiddleware');
const sequelize = require('./config/database');

dotenv.config();
const app = express();
app.use(express.json());

// ربط الرّوتات
app.use('/api/auth', authRoutes);
app.use('/api/products', authenticateToken, productRoutes);
app.use('/api/users', userRoutes);

const PORT = process.env.PORT || 5000;

sequelize.sync({ alter: true }) 
  .then(() => {
    console.log('Database synced safely!');
    // إضافة '0.0.0.0' بتضمن إن السيرفر يشوف طلبات الموبايل
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(err => console.error('Error syncing database:', err));