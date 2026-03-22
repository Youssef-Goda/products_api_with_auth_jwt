'use strict';

const { CartService, CartServiceError } = require('../services/CartService');

// ─────────────────────────────────────────────────────────────────────────────
// Agentic Response Envelope
// Every endpoint returns this exact shape so the Flutter AI agent can parse
// responses deterministically without defensive pattern-matching.
//
// {
//   success : boolean,
//   action  : string,   — machine-readable action label
//   message : string,   — human-readable summary
//   data    : object | null,
//   error   : { code: string, detail: string } | null
// }
// ─────────────────────────────────────────────────────────────────────────────
function ok(res, action, message, data, statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        action,
        message,
        data,
        error: null,
    });
}

function fail(res, action, err) {
    const isKnown = err instanceof CartServiceError;
    const statusCode = isKnown ? err.statusCode : 500;
    const code = isKnown ? err.code : 'INTERNAL_SERVER_ERROR';
    const detail = err.message;

    if (!isKnown) {
        console.error(`❌ [CartController] Unexpected error in action=${action}:`, err);
    }

    return res.status(statusCode).json({
        success: false,
        action,
        message: 'Cart operation failed.',
        data: null,
        error: { code, detail },
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// CartController
// ─────────────────────────────────────────────────────────────────────────────
const CartController = {

    /**
     * GET /api/cart
     * Fetch the authenticated user's cart, enriched with product details.
     */
    async getCart(req, res) {
        const ACTION = 'CART_FETCH';
        try {
            const userId = req.user.id;
            const cart = await CartService.getCart(userId);
            return ok(res, ACTION, `Cart fetched successfully. ${cart.item_count} item(s) found.`, cart);
        } catch (err) {
            return fail(res, ACTION, err);
        }
    },

    /**
     * POST /api/cart/add
     * Body: { productId: string, quantity: number }
     */
    async addItem(req, res) {
        const ACTION = 'CART_ADD';
        try {
            const userId = req.user.id;
            const { productId, quantity = 1 } = req.body;

            if (!productId) {
                throw new CartServiceError('MISSING_PRODUCT_ID', '`productId` is required in the request body.');
            }

            const parsedQty = parseInt(quantity, 10);
            const cartItem = await CartService.addItem(userId, productId, parsedQty);

            return ok(res, ACTION, 'Item added to cart successfully.', { cart_item: cartItem }, 201);
        } catch (err) {
            return fail(res, ACTION, err);
        }
    },

    /**
     * PUT /api/cart/update
     * Body: { productId: string, quantity: number }
     * Sets the quantity to exactly the requested value (not incremental).
     */
    async updateItem(req, res) {
        const ACTION = 'CART_UPDATE';
        try {
            const userId = req.user.id;
            const { productId, quantity } = req.body;

            if (!productId) {
                throw new CartServiceError('MISSING_PRODUCT_ID', '`productId` is required in the request body.');
            }
            if (quantity === undefined || quantity === null) {
                throw new CartServiceError('MISSING_QUANTITY', '`quantity` is required in the request body.');
            }

            const parsedQty = parseInt(quantity, 10);
            const cartItem = await CartService.updateItem(userId, productId, parsedQty);

            return ok(res, ACTION, `Cart item updated to quantity ${parsedQty}.`, { cart_item: cartItem });
        } catch (err) {
            return fail(res, ACTION, err);
        }
    },

    /**
     * DELETE /api/cart/remove/:productId
     * Removes a single product from the user's cart.
     */
    async removeItem(req, res) {
        const ACTION = 'CART_REMOVE';
        try {
            const userId = req.user.id;
            const { productId } = req.params;

            await CartService.removeItem(userId, productId);
            return ok(res, ACTION, 'Item removed from cart.', { removed_product_id: productId });
        } catch (err) {
            return fail(res, ACTION, err);
        }
    },

    /**
     * DELETE /api/cart/clear
     * Wipes the authenticated user's entire cart.
     */
    async clearCart(req, res) {
        const ACTION = 'CART_CLEAR';
        try {
            const userId = req.user.id;
            const result = await CartService.clearCart(userId);
            return ok(res, ACTION, `Cart cleared. ${result.deletedCount} item(s) removed.`, result);
        } catch (err) {
            return fail(res, ACTION, err);
        }
    },
};

module.exports = CartController;
