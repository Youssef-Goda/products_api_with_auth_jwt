const { Sequelize } = require('sequelize');
const path = require('path'); // ضيف المكتبة دي

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: './database.sqlite', // مسار الملف بتاعك
  pool: {
    max: 5,
    min: 0,
    acquire: 30000,
    idle: 10000
  },
  // أهم سطر لحل مشكلة اللوك
  retry: {
    match: [/SQLITE_BUSY/],
    max: 5
  }
});

module.exports = sequelize;