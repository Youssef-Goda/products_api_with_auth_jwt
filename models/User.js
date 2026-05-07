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
    resetOtpExpiry: { type: DataTypes.BIGINT, allowNull: true },

    // ── Extended Profile Fields ─────────────────────────────────────────────
    phoneNumber: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'phone_number'
    },
    birthDate: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        field: 'birth_date'
    },
    gender: {
        type: DataTypes.ENUM('male', 'female', 'other'),
        allowNull: true,
        field: 'gender'
    },
    profilePicture: {
        type: DataTypes.STRING, // ImgBB URL
        allowNull: true,
        field: 'profile_picture'
    },

    // ── Secure Email Change Flow Fields ────────────────────────────────────
    pendingEmail: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'pending_email'
    },
    emailChangeOtp: {
        type: DataTypes.STRING,
        allowNull: true,
        field: 'email_change_otp'
    },
    emailChangeOtpExpiry: {
        type: DataTypes.BIGINT,
        allowNull: true,
        field: 'email_change_otp_expiry'
    },
    // Tracks that identity has been confirmed (step 1) before sending OTP to new email (step 2)
    emailChangeVerified: {
        type: DataTypes.BOOLEAN,
        defaultValue: false,
        field: 'email_change_verified'
    }
}, {
    tableName: 'users',
    timestamps: true
});

module.exports = User;