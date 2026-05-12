const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
        field: 'id'
    },
    serial_id: {
        type: DataTypes.INTEGER,
        primaryKey: false,
        autoIncrement: true,
        field: 'serial_id'
    },
    code: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'code'
    },
    firstName: { type: DataTypes.STRING, allowNull: false, field: 'firstName' },
    lastName: { type: DataTypes.STRING, allowNull: false, field: 'lastName' },
    email: { type: DataTypes.STRING, unique: true, allowNull: false, field: 'email' },

    // allowNull: true — Google users have no password (they auth via Supabase OAuth)
    password: { type: DataTypes.STRING, allowNull: true, field: 'password' },

    role: {
        type: DataTypes.STRING,
        defaultValue: 'user',
        field: 'role'
    },
    isActive: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        field: 'isActive'
    },
    refreshToken: { type: DataTypes.STRING, allowNull: true, field: 'refreshToken' },
    resetOtp: { type: DataTypes.STRING, allowNull: true, field: 'resetOtp' },
    resetOtpExpiry: { type: DataTypes.BIGINT, allowNull: true, field: 'resetOtpExpiry' },

    // ── Extended Profile Fields ─────────────────────────────────────────────
    phoneNumber: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'phoneNumber'
    },
    birthDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'birthDate'
    },
    gender: {
        type: DataTypes.ENUM('male', 'female', 'other'),
        allowNull: true,
        field: 'gender'
    },
    profilePicture: {
        type: DataTypes.STRING, // ImgBB URL
        allowNull: true,
        field: 'profilePicture'
    },

    // ── Secure Email Change Flow Fields ────────────────────────────────────
    pendingEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'pendingEmail'
    },
    emailChangeOtp: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'emailChangeOtp'
    },
    emailChangeOtpExpiry: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'emailChangeOtpExpiry'
    },
    // Tracks that identity has been confirmed (step 1) before sending OTP to new email (step 2)
    emailChangeVerified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'emailChangeVerified'
    },
    // ── FCM Push Notification Token ─────────────────────────────────────────
    fcmToken: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'fcmToken'
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
    tableName: 'users',
    timestamps: true,
    underscored: false
});

module.exports = User;