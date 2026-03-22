const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    serial_id: {
        type: DataTypes.INTEGER,
        primaryKey: false,
        autoIncrement: true
    },
    code: {
        type: DataTypes.STRING,
        allowNull: true
    },
    firstName: { type: DataTypes.STRING, allowNull: false },
    lastName: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, unique: true, allowNull: false },

    // allowNull: true — Google users have no password (they auth via Supabase OAuth)
    password: { type: DataTypes.STRING, allowNull: true },

    role: {
        type: DataTypes.STRING,
        defaultValue: 'user'
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'is_active'
    },
    refreshToken: { type: DataTypes.STRING, allowNull: true },
    resetOtp: { type: DataTypes.STRING, allowNull: true },
    resetOtpExpiry: { type: DataTypes.BIGINT, allowNull: true }
}, {
    tableName: 'users',
    timestamps: true
});

module.exports = User;