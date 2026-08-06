require('dotenv').config();
require('pg');
const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

// ── Routes ────────────────────────────────────────────────────────────────────
const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const userRoutes = require('./routes/userRoutes');
const cartRoutes = require('./routes/cartRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const categoryRoutes = require('./routes/categoryRoutes');
const orderRoutes = require('./routes/orderRoutes');
const addressRoutes = require('./routes/addressRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const ownerRoutes        = require('./routes/ownerRoutes');
const bannerRoutes       = require('./routes/bannerRoutes');

const sequelize = require('./config/database');

// ── Ensure Sequelize is aware of all models so sync() registers them ──────────
require('./models/Cart');
require('./models/CartEvent');
require('./models/Category');
require('./models/Product');  
require('./models/User');
require('./models/Banner');
require('./models/ActivityLog');

dotenv.config();
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

app.get('/api/test-connection', async (req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ status: 'Connected', message: 'Server can see Supabase!' });
  } catch (err) {
    res.status(500).json({ status: 'Failed', error: err.message });
  }
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/users', userRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/addresses', addressRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/owner',         ownerRoutes);         // Owner Control — owner only
app.use('/api/banners',       bannerRoutes);

const PORT = process.env.PORT || 5000;

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