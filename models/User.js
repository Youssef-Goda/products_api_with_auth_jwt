// const { DataTypes } = require('sequelize');
// const sequelize = require('../config/database'); 

// const User = sequelize.define('User', {
//     username: { 
//         type: DataTypes.STRING, 
//         unique: false, 
//         allowNull: false 
//     },
//     email: { 
//         type: DataTypes.STRING, 
//         unique: true, 
//         allowNull: false,
//         validate: {
//             isEmail: true
//         }
//     },
//     password: { 
//         type: DataTypes.STRING, 
//         allowNull: false 
//     },
//     refreshToken: { 
//         type: DataTypes.STRING 
//     },
//     // حقول خاصة بتفعيل الحساب عند التسجيل لأول مرة
//     otp: {
//         type: DataTypes.STRING,
//         allowNull: true
//     },
//     otpExpiry: {
//         type: DataTypes.BIGINT,
//         allowNull: true
//     },
//     isVerified: {
//         type: DataTypes.BOOLEAN,
//         defaultValue: false
//     },
//     // حقول خاصة بإعادة تعيين كلمة المرور (Reset Password)
//     resetOtp: {
//         type: DataTypes.STRING,
//         allowNull: true
//     },
//     resetOtpExpiry: {
//         type: DataTypes.BIGINT,
//         allowNull: true
//     }
// }, {
//     tableName: 'users',
//     timestamps: true
// });

// module.exports = User;


const { DataTypes } = require('sequelize');
const sequelize = require('../config/database'); 

const User = sequelize.define('User', {
    // تم استبدال username بـ firstName و lastName
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