const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Product = sequelize.define('Product', {
    // 1. الـ ID لازم يكون UUID عشان يطابق سوبا بيز
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true
    },
    // 2. الحقول الجديدة اللي عملناها في الداتا بيز
    serial_id: {
        type: DataTypes.INTEGER,
        primaryKey: false,
        autoIncrement: true
    },
    code: {
        type: DataTypes.STRING,
        field: 'code' // الاسم في سوبا بيز
    },
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT },
    price: { type: DataTypes.FLOAT, allowNull: false },
    imageUrls: {
        type: DataTypes.JSONB,
        defaultValue: [],
        field: 'imageUrls'
    },
    oldPrice: { type: DataTypes.FLOAT, allowNull: true },
    rating: { type: DataTypes.FLOAT, defaultValue: 0.0 },
    countInStock: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
        field: 'countInStock'
    }
}, {
    tableName: 'Products', // اتأكد إن الحرف P كبير زي ما هو في سوبا
    timestamps: true
});

module.exports = Product;