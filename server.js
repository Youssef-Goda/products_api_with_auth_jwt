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

// Helper: Strips quotes and whitespace from environment variables
function cleanEnv(val) {
  if (!val) return '';
  return String(val).trim().replace(/^["']|["']$/g, '');
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const rawAllowedOrigins = cleanEnv(process.env.ALLOWED_ORIGINS);
const allowedOriginsList = rawAllowedOrigins
  ? rawAllowedOrigins.split(',').map((o) => cleanEnv(o)).filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:5000', 'http://127.0.0.1:3000'];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);

    // If allowedOrigins contains wildcard '*' or matches exact requesting origin
    if (allowedOriginsList.includes('*') || allowedOriginsList.includes(origin)) {
      return callback(null, true);
    }

    // Allow local development ports (localhost / 127.0.0.1)
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }

    // Allow FRONTEND_URL if set in environment
    const frontendUrl = cleanEnv(process.env.FRONTEND_URL);
    if (frontendUrl) {
      try {
        const parsedOrigin = new URL(frontendUrl).origin;
        if (origin === frontendUrl || origin === parsedOrigin) {
          return callback(null, true);
        }
      } catch (_) {}
    }

    console.warn(`⚠️ [CORS] Blocked origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Origin',
    'X-Requested-With',
    'Content-Type',
    'Accept',
    'Authorization',
  ],
  exposedHeaders: ['Authorization'],
  optionsSuccessStatus: 200, // legacy browsers support
};

// Must come BEFORE all route definitions
app.use(cors(corsOptions));

// Handle all OPTIONS pre-flight requests globally
app.options('*', cors(corsOptions));

// ── Body Parsers ──────────────────────────────────────────────────────────────
// Skip express.json() for paymob webhook so express.raw() can capture the raw Buffer for HMAC validation
app.use((req, res, next) => {
  if (req.originalUrl?.includes('/payments/paymob/webhook') || req.path?.includes('/payments/paymob/webhook')) {
    return next();
  }
  express.json()(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// ── Paymob Routes ─────────────────────────────────────────────────────────────
app.use('/api/v1/payments/paymob', paymobRoutes);

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
app.use('/api/v1/orders',     orderRoutes);   // exposes GET /api/v1/orders/:id/payment-status
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