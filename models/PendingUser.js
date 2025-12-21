// // models/PendingUser.js
// const { DataTypes, Op } = require('sequelize'); // ضم Op هنا
// const sequelize = require('../config/database'); // اتأكد الباث صح حسب ملف الكونفيج

// const PendingUser = sequelize.define('PendingUser', {
//     id: {
//         type: DataTypes.INTEGER,
//         autoIncrement: true, // مهم جداً عشان Sequelize يعمل insert صح
//         primaryKey: true
//     },
//     username: {
//         type: DataTypes.STRING,
//         allowNull: false,
//         unique: true
//     },
//     email: {
//         type: DataTypes.STRING,
//         allowNull: false,
//         unique: true,
//         validate: {
//             isEmail: true
//         }
//     },
//     password: {
//         type: DataTypes.STRING,
//         allowNull: false
//     },
//     otp: {
//         type: DataTypes.STRING,
//         allowNull: true
//     },
//     otpExpiry: {
//         type: DataTypes.DATE,
//         allowNull: true
//     }
// }, {
//     tableName: 'pending_users',
//     timestamps: true // بيعمل createdAt و updatedAt تلقائي
// });

// // ===================== دالة مساعدة =====================
// PendingUser.cleanupExisting = async function(username, email) {
//     const existing = await PendingUser.findOne({
//         where: {
//             [Op.or]: [{ username }, { email }]
//         }
//     });
//     if (existing) {
//         await existing.destroy();
//     }
// };

// module.exports = PendingUser;


const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');

const PendingUser = sequelize.define('PendingUser', {
    id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true
    },
    // تم حذف username وإضافة الحقول الجديدة
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
        type: DataTypes.BIGINT, // يفضل BIGINT للتعامل مع Date.now() بسهولة
        allowNull: true
    }
}, {
    tableName: 'pending_users',
    timestamps: true 
});

// ===================== دالة مساعدة =====================
// عدلنا الدالة عشان تبحث بالإيميل فقط بما إننا لغينا الـ Username
PendingUser.cleanupExisting = async function(email) {
    const existing = await PendingUser.findOne({
        where: { email }
    });
    if (existing) {
        await existing.destroy();
    }
};

module.exports = PendingUser;