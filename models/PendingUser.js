const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PendingUser = sequelize.define('PendingUser', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'id'
    },
    firstName: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'firstName'
    },
    lastName: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'lastName'
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: {
            isEmail: true
        },
        field: 'email'
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false,
        field: 'password'
    },
    otp: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'otp'
    },
    otpExpiry: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'otpExpiry'
    },
    createdAt: {
        type: DataTypes.DATE,
        field: 'createdAt'
    },
    updatedAt: {
        type: DataTypes.DATE,
        field: 'updatedAt'
    }
}, {
    tableName: 'pending_users',
    timestamps: true,
    underscored: false
});

// Helper: remove any existing pending record for this email before creating a new one
PendingUser.cleanupExisting = async function (email) {
    const existing = await PendingUser.findOne({ where: { email } });
    if (existing) {
        await existing.destroy();
    }
};

module.exports = PendingUser;