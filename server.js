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
const analyticsRoutes    = require('./routes/analyticsRoutes');
const moderationRoutes   = require('./routes/moderationRoutes');
const settingsRoutes     = require('./routes/settingsRoutes');
const paymobRoutes       = require('./routes/paymobRoutes');

const sequelize = require('./config/database');

// ── Ensure Sequelize is aware of all models so sync() registers them ──────────
require('./models/Cart');
require('./models/CartEvent');
require('./models/Category');
require('./models/Product');  
require('./models/User');
require('./models/Banner');
require('./models/ActivityLog');
require('./models/StoreSetting');

dotenv.config();
const app = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
  ],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200, // some legacy browsers (IE11) choke on 204
};

// Must come BEFORE all route definitions
app.use(cors(corsOptions));

// Handle all OPTIONS pre-flight requests globally
app.options('*', cors(corsOptions));

// ── Paymob webhook uses express.raw() ─ mount BEFORE express.json() ──────────
// The scoped raw-body parser inside paymobRoutes preserves the exact bytes
// Paymob signed, which is required for HMAC-SHA512 verification.
app.use('/api/v1/payments/paymob', paymobRoutes);

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
app.use('/api/analytics',     analyticsRoutes);
app.use('/api/moderation',    moderationRoutes);
app.use('/api/settings',      settingsRoutes);

// ── API v1 Aliases ────────────────────────────────────────────────────────────
app.use('/api/v1/settings',   settingsRoutes);
app.use('/api/v1/owner',      ownerRoutes);
app.use('/api/v1/banners',    bannerRoutes);
// Note: /api/v1/payments/paymob is already mounted above express.json()

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