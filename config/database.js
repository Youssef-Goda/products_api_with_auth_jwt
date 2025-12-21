const { Sequelize } = require('sequelize');
const path = require('path'); // ضيف المكتبة دي

const sequelize = new Sequelize({
  dialect: 'sqlite',
  // path.join بتخلي الملف يتشاف صح في أي مكان
  storage: path.join(__dirname, '../database.sqlite') 
});

module.exports = sequelize;