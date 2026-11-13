'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const PostgresQuery = require('sequelize/lib/dialects/postgres/query');
const { prepareValue } = require('pg/lib/utils');

function loadPromotionRoutes({ duplicateCodeOnce = null, duplicateGeneratedPrefix = null } = {}) {
  const realLoad = Module._load;
  const inserted = [];
  const insertStatements = [];
  const insertBinds = [];
  let duplicateIssued = false;
  const sequelize = {
    transaction: async (callback) => callback({}),
    query: async (sql, options = {}) => {
      if (sql.includes('SELECT minimum_gross_margin')) return [{ minimum_gross_margin: 20 }];
      if (sql.includes('INSERT INTO public.promotions')) {
        insertStatements.push(sql);
        insertBinds.push(options.bind);
        const duplicateCustom = duplicateCodeOnce != null && options.bind.code === duplicateCodeOnce;
        const duplicateGenerated = duplicateGeneratedPrefix != null &&
          String(options.bind.code || '').startsWith(duplicateGeneratedPrefix);
        if (!duplicateIssued && (duplicateCustom || duplicateGenerated)) {
          duplicateIssued = true;
          const error = new Error('duplicate key value violates unique constraint');
          error.name = 'SequelizeUniqueConstraintError';
          throw error;
        }
        const row = {
          id: `promotion-${inserted.length + 1}`,
          coupon_code: options.bind.code,
          kind: options.bind.kind,
          status: options.bind.status,
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
  return { router, inserted, insertStatements, insertBinds };
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

test('promotion creation binds empty UUID arrays safely and returns generated code', async () => {
  const { router, inserted, insertStatements, insertBinds } = loadPromotionRoutes();
  const response = await invokeCreate(router, {
    name: 'Generated coupon', kind: 'coupon', autoGenerateCode: true, couponPrefix: 'sale-',
    discountType: 'percentage', discountValue: 10,
  });
  assert.equal(response.statusCode, 201);
  assert.match(inserted[0].coupon_code, /^SALE-[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(response.body.data.coupon_code, inserted[0].coupon_code);
  assert.match(insertStatements[0], /CAST\(\$productIds AS uuid\[\]\)/);
  assert.doesNotMatch(insertStatements[0], /:productIds/);
  assert.deepEqual(insertBinds[0].productIds, []);
  assert.deepEqual(insertBinds[0].categoryIds, []);
  assert.deepEqual(insertBinds[0].customerIds, []);
});

test('Sequelize sends an empty UUID array as a bind value, not missing SQL text', () => {
  const [sql, values] = PostgresQuery.formatBindParameters(
    'CAST($eligibleProductIds AS uuid[])',
    { eligibleProductIds: [] },
    'postgres',
  );
  assert.equal(sql, 'CAST($1 AS uuid[])');
  assert.deepEqual(values, [[]]);
  assert.equal(prepareValue(values[0]), '{}');
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

test('automatic promotions also bind empty eligibility arrays without malformed commas', async () => {
  const { router, insertStatements } = loadPromotionRoutes();
  const response = await invokeCreate(router, {
    name: 'Automatic offer', kind: 'automatic', discountType: 'fixed', discountValue: 5,
  });
  assert.equal(response.statusCode, 201);
  assert.match(insertStatements[0], /CAST\(\$categoryIds AS uuid\[\]\)/);
  assert.match(insertStatements[0], /CAST\(\$customerIds AS uuid\[\]\)/);
});

test('duplicate custom coupon code returns a conflict instead of a SQL error', async () => {
  const { router } = loadPromotionRoutes({ duplicateCodeOnce: 'DUPLICATE' });
  const response = await invokeCreate(router, {
    name: 'Duplicate coupon', kind: 'coupon', couponCode: 'duplicate',
    discountType: 'fixed', discountValue: 5,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.message, 'Coupon code already exists.');
});

test('generated coupon code retries after a unique-index collision', async () => {
  const { router, insertStatements } = loadPromotionRoutes({ duplicateGeneratedPrefix: 'RETRY-' });
  const response = await invokeCreate(router, {
    name: 'Retry coupon', kind: 'coupon', autoGenerateCode: true, couponPrefix: 'retry-',
    discountType: 'percentage', discountValue: 5,
  });
  assert.equal(response.statusCode, 201);
  assert.equal(insertStatements.length, 2);
  assert.match(response.body.data.coupon_code, /^RETRY-[A-HJ-NP-Z2-9]{10}$/);
});

test('invalid generated-code prefix is rejected before attempting SQL', async () => {
  const { router, insertStatements } = loadPromotionRoutes();
  const response = await invokeCreate(router, {
    name: 'Bad prefix', kind: 'coupon', autoGenerateCode: true, couponPrefix: 'bad prefix',
    discountType: 'percentage', discountValue: 5,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(insertStatements.length, 0);
});
