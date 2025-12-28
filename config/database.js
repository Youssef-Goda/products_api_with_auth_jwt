// const { Sequelize } = require('sequelize');
// const path = require('path'); // ضيف المكتبة دي

// const sequelize = new Sequelize({
//   dialect: 'sqlite',
//   storage: './database.sqlite', // مسار الملف بتاعك
//   pool: {
//     max: 5,
//     min: 0,
//     acquire: 30000,
//     idle: 10000
//   },
//   // أهم سطر لحل مشكلة اللوك
//   retry: {
//     match: [/SQLITE_BUSY/],
//     max: 5
//   }
// });

// module.exports = sequelize;
const { Sequelize } = require('sequelize');

// حط اللينك بتاعك هنا (تأكد إنك كتبت الباسورد الحقيقية مكان [YOUR-PASSWORD])
const connectionString = 'postgresql://postgres:[Yooseff77)($)(@))si]@db.zpznjjyqldxwfnklkvgh.supabase.co:5432/postgres';

const sequelize = new Sequelize(connectionString, {
  dialect: 'postgres',
  protocol: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false // ضروري جداً عشان الربط ينجح مع Vercel و Supabase
    }
  },
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  }
});

module.exports = sequelize;