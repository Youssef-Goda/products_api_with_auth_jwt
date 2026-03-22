const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * Cart — maps to the `cart_items` table in Supabase.
 * Each row represents a unique user ↔ product pair.
 * A UNIQUE constraint on (user_id, product_id) is enforced at the DB level.
 */
const Cart = sequelize.define('Cart', {
    id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
    },
    user_id: {
        type: DataTypes.UUID,
        allowNull: false,
    },
    product_id: {
        type: DataTypes.UUID,
        allowNull: false,
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 1,
        validate: { min: 1 },
    },
}, {
    tableName: 'cart_items',
    timestamps: true,
});

module.exports = Cart;
