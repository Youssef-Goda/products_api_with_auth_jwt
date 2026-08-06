const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const User = require('./User');

const ActivityLog = sequelize.define('ActivityLog', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.UUID,
    allowNull: true,
    field: 'user_id',
  },
  action: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  entityType: {
    type: DataTypes.STRING(50),
    allowNull: false,
    field: 'entity_type',
  },
  entityId: {
    type: DataTypes.STRING(100),
    allowNull: true,
    field: 'entity_id',
  },
  details: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
}, {
  tableName: 'activity_logs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

// Association to fetch user details with the logs
ActivityLog.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = ActivityLog;
