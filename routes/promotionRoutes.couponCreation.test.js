'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadPromotionRoutes() {
  const realLoad = Module._load;
  const inserted = [];
  const sequelize = {
    transaction: async (callback) => callback({}),
    query: async (sql, options = {}) => {
      if (sql.includes('SELECT minimum_gross_margin')) return [{ minimum_gross_margin: 20 }];
      if (sql.includes('INSERT INTO promotions')) {
        const row = {
          id: `promotion-${inserted.length + 1}`,
          coupon_code: options.replacements.code,
          kind: options.replacements.kind,
          status: options.replacements.status,
          settings_version: 1,
        };
        inserted.push(row);
        return [[row], {}];
      }
      return [];
    },
  };
  Module._load = function (request, parent, isMain) {
    if (parent?.filename?.endsWith('/routes/promotionRoutes.js')) {
      if (request === '../config/database') return sequelize;
      if (request === '../models/Product') return { findAll: async () => [{ id: 'prod-1', price: 100, costPrice: 20, categoryId: 'cat-1' }] };
      if (request === '../models/User') return { findByPk: async () => ({ id: 'admin-1', role: 'admin', isActive: true }), findAll: async () => [] };
      if (request === '../middlewares/authMiddleware') return { authenticateToken: (req, res, next) => next() };
      if (request === '../utils/fcmService') return { sendNotification: async () => {} };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve('./promotionRoutes')];
  const router = require('./promotionRoutes');
  Module._load = realLoad;
  return { router, inserted };
}

async function invokeCreate(router, body) {
  const route = router.stack.find((layer) => layer.route?.path === '/' && layer.route.methods.post);
  const handlers = route.route.stack.map((layer) => layer.handle);
  const req = { user: { id: 'admin-1', role: 'admin' }, body };
  const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  let index = 0;
  const next = async (error) => { if (error) throw error; const handler = handlers[index++]; if (handler) await handler(req, res, next); };
  await next();
  return res;
}

test('promotion creation endpoint accepts server generation and returns its code', async () => {
  const { router, inserted } = loadPromotionRoutes();
  const response = await invokeCreate(router, {
    name: 'Generated coupon', kind: 'coupon', autoGenerateCode: true, couponPrefix: 'sale-',
    discountType: 'percentage', discountValue: 10,
  });
  assert.equal(response.statusCode, 201);
  assert.match(inserted[0].coupon_code, /^SALE-[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(response.body.data.coupon_code, inserted[0].coupon_code);
});

test('promotion creation endpoint continues to accept custom backend-normalized codes', async () => {
  const { router, inserted } = loadPromotionRoutes();
  const response = await invokeCreate(router, {
    name: 'Custom coupon', kind: 'coupon', couponCode: '  spring_10 ',
    discountType: 'fixed', discountValue: 10,
  });
  assert.equal(response.statusCode, 201);
  assert.equal(inserted[0].coupon_code, 'SPRING_10');
});
