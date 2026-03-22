const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PendingUser = sequelize.define('PendingUser', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    firstName: {
        type: DataTypes.STRING,
        allowNull: false
    },
    lastName: {
        type: DataTypes.STRING,
        allowNull: false
    },
    email: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        validate: {
            isEmail: true
        }
    },
    password: {
        type: DataTypes.STRING,
        allowNull: false
    },
    otp: {
        type: DataTypes.STRING,
        allowNull: true
    },
    otpExpiry: {
        type: DataTypes.BIGINT,
        allowNull: true
    }
}, {
    tableName: 'pending_users',
    timestamps: true
});

// Helper: remove any existing pending record for this email before creating a new one
PendingUser.cleanupExisting = async function (email) {
    const existing = await PendingUser.findOne({ where: { email } });
    if (existing) {
        await existing.destroy();
    }
};

module.exports = PendingUser;