const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StoreSetting = sequelize.define('StoreSetting', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    defaultValue: 1,
  },
  is_banner_enabled: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'is_banner_enabled',
  },
}, {
  tableName: 'store_settings',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = StoreSetting;
