const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Product = sequelize.define('Product', {
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
        field: 'code'
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
    },

    // ── Category FK (REQUIRED) ──────────────────────────────────────────────
    categoryId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
            model: 'categories',
            key: 'id'
        },
        onDelete: 'RESTRICT' // Prevent deleting a category that has products
    },

    // ── Dynamic specs (RAM, size, color, etc.) ─────────────────────────────
    attributes: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: {}
    }
}, {
    tableName: 'Products',
    timestamps: true
});

module.exports = Product;