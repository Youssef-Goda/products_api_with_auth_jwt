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

// هنا بنخلي الكود يقرأ من البيئة المحيطة (Vercel) أو يستخدم اللينك المباشر كخيار احتياطي
const connectionString = process.env.SUPABASE_DATABASE_URL || 'postgresql://postgres:UYdpQgcnKh2Zl7m6@db.zpznjjyqldxwfnklkvgh.supabase.co:5432/postgres';

const sequelize = new Sequelize(connectionString, {
  dialect: 'postgres',
  protocol: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false // ضروري جداً للربط بين Vercel و Supabase
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