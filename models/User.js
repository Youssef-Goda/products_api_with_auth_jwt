const { DataTypes } = require('sequelize');
const sequelize = require('../config/database'); 

const User = sequelize.define('User', {
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
        unique: true, 
        allowNull: false,
        validate: {
            isEmail: true
        }
    },
    password: { 
        type: DataTypes.STRING, 
        allowNull: false 
    },
    refreshToken: { 
        type: DataTypes.STRING 
    },
    // حقول إعادة تعيين كلمة المرور (Reset Password) فقط
    resetOtp: {
        type: DataTypes.STRING,
        allowNull: true
    },
    resetOtpExpiry: {
        type: DataTypes.BIGINT,
        allowNull: true
    }
}, {
    tableName: 'users',
    timestamps: true // بيضيف createdAt و updatedAt تلقائياً
});

module.exports = User;