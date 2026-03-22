'use strict';

const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middlewares/authMiddleware');
const CartController = require('../controllers/CartController');

// All cart endpoints are protected — user identity is read from req.user (JWT payload)
router.use(authenticateToken);

/**
 * GET /api/cart
 * Returns the full cart for the authenticated user, enriched with product data.
 *
 * Response shape:
 * {
 *   success: true,
 *   action: "CART_FETCH",
 *   message: "Cart fetched successfully. N item(s) found.",
 *   data: {
 *     items: [{ cart_item_id, product_id, product_code, product_name, image_url,
 *               unit_price, old_price, rating, count_in_stock, quantity, subtotal }],
 *     item_count: N,
 *     total_price: 0.00,
 *     currency: "EGP"
 *   },
 *   error: null
 * }
 */
router.get('/', CartController.getCart);

/**
 * POST /api/cart/add
 * Body: { productId: "<UUID>", quantity: <int> }
 *
 * Validates stock in real-time before adding.
 * If the product is already in the cart, quantities are SUMMED and validated together.
 *
 * Error codes:
 *   STOCK_INSUFFICIENT  — requested + existing exceeds countInStock
 *   PRODUCT_NOT_FOUND   — productId does not exist
 *   INVALID_QUANTITY    — quantity < 1 or not an integer
 *   MISSING_PRODUCT_ID  — productId absent from body
 */
router.post('/add', CartController.addItem);

/**
 * PUT /api/cart/update
 * Body: { productId: "<UUID>", quantity: <int> }
 *
 * Sets the cart quantity to the provided value (absolute, not incremental).
 * Performs a full stock validation against the new desired quantity.
 *
 * Error codes:
 *   STOCK_INSUFFICIENT   — new quantity exceeds countInStock
 *   CART_ITEM_NOT_FOUND — item not yet in cart (use /add first)
 *   INVALID_QUANTITY     — quantity < 1 or not an integer
 */
router.put('/update', CartController.updateItem);

/**
 * DELETE /api/cart/remove/:productId
 * Removes a single product line from the cart.
 *
 * Error codes:
 *   CART_ITEM_NOT_FOUND — item not in cart
 */
router.delete('/remove/:productId', CartController.removeItem);

/**
 * DELETE /api/cart/clear
 * Wipes the entire cart for the authenticated user.
 */
router.delete('/clear', CartController.clearCart);

module.exports = router;
