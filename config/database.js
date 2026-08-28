// const { Sequelize } = require('sequelize');
// const pg = require('pg');

// // انسخ الرابط بتاعك من ملف الـ .env وحطه هنا مكان النجوم
// const databaseUrl = 'postgres://postgres.zpznjjyqldxwfnklkvgh:UYdpQgcnKh2Zl7m6@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?pgbouncer=true';

// const sequelize = new Sequelize(databaseUrl, {
//   dialect: 'postgres',
//   dialectModule: pg,
//   dialectOptions: {
//     ssl: {
//       require: true,
//       rejectUnauthorized: false
//     }
//   }
// });

// module.exports = sequelize;




const { Sequelize } = require('sequelize');
const pg = require('pg');

// 1. استخدام بورت 6543 (Transaction Pooler) بدلاً من 5432
const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres.zpznjjyqldxwfnklkvgh:UYdpQgcnKh2Zl7m6@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true';

const sequelize = new Sequelize(databaseUrl, {
  dialect: 'postgres',
  dialectModule: pg,
  // 2. تحديد pool صغير جداً يناسب بيئة الـ Serverless
  pool: {
    max: 2,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  },
  logging: false // لتقليل الـ Logs في الإنتاج
});

module.exports = sequelize;