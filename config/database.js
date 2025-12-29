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
const pg = require('pg'); 

const sequelize = new Sequelize(process.env.SUPABASE_DATABASE_URL, {
  dialect: 'postgres',
  dialectModule: pg, // السطر ده هو اللي هيحل مشكلة "Please install pg"
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  }
});

module.exports = sequelize;