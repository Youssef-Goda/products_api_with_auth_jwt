const { Sequelize } = require('sequelize');
const pg = require('pg');

// انسخ الرابط بتاعك من ملف الـ .env وحطه هنا مكان النجوم
const databaseUrl = 'postgres://postgres.zpznjjyqldxwfnklkvgh:UYdpQgcnKh2Zl7m6@aws-1-eu-central-1.pooler.supabase.com:5432/postgres?pgbouncer=true';

const sequelize = new Sequelize(databaseUrl, {
  dialect: 'postgres',
  dialectModule: pg,
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

module.exports = sequelize;