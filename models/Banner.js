const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Banner = sequelize.define('Banner', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  imageUrl: {
    type: DataTypes.STRING,
    allowNull: false,
    field: 'image_url',
  },
  title: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  subtitle: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    field: 'is_active',
  },
}, {
  tableName: 'banners',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Banner;
