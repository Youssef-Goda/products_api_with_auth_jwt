'use strict';

const { Op } = require('sequelize');
const Product = require('../models/Product');
const Cart = require('../models/Cart');
const CartEvent = require('../models/CartEvent');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: persist an event to the cart_events log.
// Fire-and-forget — we never let a logging failure block the user's request.
// ─────────────────────────────────────────────────────────────────────────────
async function _logEvent(userId, productId, eventType, quantity = null, meta = {}) {
    try {
        await CartEvent.create({
            user_id: userId,
            product_id: productId,
            event_type: eventType,
            quantity,
            meta,
        });
    } catch (logErr) {
        // Non-fatal — just emit to the server log so admins can investigate
        console.warn(`⚠️  [CartEvent] Failed to log ${eventType} for user=${userId}:`, logErr.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Error factory: well-typed errors the controller can convert to HTTP responses
// ─────────────────────────────────────────────────────────────────────────────
class CartServiceError extends Error {
    constructor(code, message, statusCode = 400) {
        super(message);
        this.name = 'CartServiceError';
        this.code = code;       // machine-readable, e.g. 'STOCK_INSUFFICIENT'
        this.statusCode = statusCode;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// CartService
// ─────────────────────────────────────────────────────────────────────────────
const CartService = {

    /**
     * addItem — validate stock, then upsert the cart row.
     * If the item already exists in the cart, the quantities are SUMMED.
     */
    async addItem(userId, productId, quantity = 1) {
        // 1. Validate inputs
        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new CartServiceError('INVALID_QUANTITY', 'Quantity must be a positive integer.');
        }

        // 2. Fetch the product
        const product = await Product.findByPk(productId);
        if (!product) {
            throw new CartServiceError('PRODUCT_NOT_FOUND', `No product found with id: ${productId}`, 404);
        }

        // 3. Real-time stock validation
        const existingCartItem = await Cart.findOne({
            where: { user_id: userId, product_id: productId },
        });
        const alreadyInCart = existingCartItem ? existingCartItem.quantity : 0;
        const totalRequested = alreadyInCart + quantity;

        if (totalRequested > product.countInStock) {
            throw new CartServiceError(
                'STOCK_INSUFFICIENT',
                `Only ${product.countInStock} unit(s) in stock. You already have ${alreadyInCart} in cart, so you can add at most ${product.countInStock - alreadyInCart} more.`,
            );
        }

        // 4. Upsert: create new or increment existing
        let cartItem;
        if (existingCartItem) {
            existingCartItem.quantity = totalRequested;
            cartItem = await existingCartItem.save();
        } else {
            cartItem = await Cart.create({
                user_id: userId,
                product_id: productId,
                quantity,
            });
        }

        // 5. Log the event (non-blocking)
        await _logEvent(userId, productId, 'ADD', quantity, {
            product_code: product.code,
            product_name: product.name,
            price_at_event: product.price,
            stock_remaining_after: product.countInStock - cartItem.quantity,
        });

        return cartItem;
    },

    /**
     * updateItem — set quantity to an exact value (not incremental).
     * Performs full stock validation against the new desired quantity.
     */
    async updateItem(userId, productId, quantity) {
        if (!Number.isInteger(quantity) || quantity < 1) {
            throw new CartServiceError('INVALID_QUANTITY', 'Quantity must be a positive integer.');
        }

        const product = await Product.findByPk(productId);
        if (!product) {
            throw new CartServiceError('PRODUCT_NOT_FOUND', `No product found with id: ${productId}`, 404);
        }

        // Real-time stock check against the NEW desired quantity
        if (quantity > product.countInStock) {
            throw new CartServiceError(
                'STOCK_INSUFFICIENT',
                `Only ${product.countInStock} unit(s) available. Requested: ${quantity}.`,
            );
        }

        const cartItem = await Cart.findOne({
            where: { user_id: userId, product_id: productId },
        });
        if (!cartItem) {
            throw new CartServiceError('CART_ITEM_NOT_FOUND', 'Item not found in cart. Add it first.', 404);
        }

        const previousQty = cartItem.quantity;
        cartItem.quantity = quantity;
        await cartItem.save();

        await _logEvent(userId, productId, 'UPDATE', quantity, {
            product_code: product.code,
            product_name: product.name,
            previous_qty: previousQty,
            price_at_event: product.price,
        });

        return cartItem;
    },

    /**
     * removeItem — delete a single cart row for this user + product.
     */
    async removeItem(userId, productId) {
        const cartItem = await Cart.findOne({
            where: { user_id: userId, product_id: productId },
        });
        if (!cartItem) {
            throw new CartServiceError('CART_ITEM_NOT_FOUND', 'Item not found in cart.', 404);
        }

        const removedQty = cartItem.quantity;
        await cartItem.destroy();

        // Best-effort: fetch product for richer event meta
        const product = await Product.findByPk(productId).catch(() => null);

        await _logEvent(userId, productId, 'REMOVE', removedQty, {
            product_code: product?.code ?? null,
            product_name: product?.name ?? null,
        });
    },

    /**
     * clearCart — delete all cart rows for a given user.
     */
    async clearCart(userId) {
        const deletedCount = await Cart.destroy({
            where: { user_id: userId },
        });

        await _logEvent(userId, null, 'CLEAR', null, {
            items_removed: deletedCount,
        });

        return { deletedCount };
    },

    /**
     * getCart — return the full cart enriched with product details.
     * Calculates per-item subtotal and total cart value.
     */
    async getCart(userId) {
        const cartItems = await Cart.findAll({
            where: { user_id: userId },
            order: [['createdAt', 'ASC']],
        });

        if (cartItems.length === 0) {
            return {
                items: [],
                item_count: 0,
                total_price: 0,
                currency: 'EGP', // extend via env or DB config as needed
            };
        }

        // Batch-fetch all referenced products in one query
        const productIds = cartItems.map(c => c.product_id);
        const products = await Product.findAll({
            where: { id: { [Op.in]: productIds } },
        });
        const productMap = Object.fromEntries(products.map(p => [p.id, p]));

        let totalPrice = 0;
        const enrichedItems = cartItems.map(item => {
            const product = productMap[item.product_id];
            const subtotal = product ? parseFloat((product.price * item.quantity).toFixed(2)) : 0;
            totalPrice += subtotal;

            return {
                cart_item_id: item.id,
                product_id: item.product_id,
                product_code: product?.code ?? null,
                product_name: product?.name ?? null,
                image_url: product?.imageUrls?.[0] ?? null,
                unit_price: product?.price ?? null,
                old_price: product?.oldPrice ?? null,
                rating: product?.rating ?? null,
                count_in_stock: product?.countInStock ?? null,
                quantity: item.quantity,
                subtotal,
            };
        });

        return {
            items: enrichedItems,
            item_count: enrichedItems.length,
            total_price: parseFloat(totalPrice.toFixed(2)),
            currency: 'EGP',
        };
    },
};

module.exports = { CartService, CartServiceError };
