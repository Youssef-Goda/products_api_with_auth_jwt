const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * CartEvent — append-only event log mapping to `cart_events`.
 * Every mutation to the cart (add / update / remove / clear) is recorded here.
 * Designed for future analytics dashboards and admin visibility.
 *
 * event_type values:
 *   'ADD'    — item added to cart
 *   'UPDATE' — item quantity changed
 *   'REMOVE' — single item removed
 *   'CLEAR'  — entire cart wiped
 */
const CartEvent = sequelize.define('CartEvent', {
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
        allowNull: true, // nullable for CLEAR events (no single product)
    },
    event_type: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
            isIn: [['ADD', 'UPDATE', 'REMOVE', 'CLEAR']],
        },
    },
    quantity: {
        type: DataTypes.INTEGER,
        allowNull: true,
    },
    meta: {
        type: DataTypes.JSONB,
        allowNull: true,
        defaultValue: {},
        comment: 'Arbitrary JSON payload for extra context (e.g. price at time of event, product code)',
    },
}, {
    tableName: 'cart_events',
    timestamps: true,
    updatedAt: false, // events are immutable — no updatedAt needed
});

module.exports = CartEvent;
