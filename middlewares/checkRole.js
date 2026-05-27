/**
 * checkRole.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Role-Based Access Control (RBAC) middleware for the Dealio API.
 *
 * Usage (always chain AFTER authenticateToken):
 *   router.post('/add', authenticateToken, checkRole(['admin', 'super_admin']), handler);
 *
 * The user's role is read from the JWT payload (req.user.role), which is
 * embedded at login time by generateAccessToken(). This avoids a DB
 * round-trip on every protected request.
 *
 * To add a new role (e.g. 'manager'), simply:
 *   1. Add it to the ENUM in models/User.js
 *   2. Pass it in the allowedRoles array where needed — no other changes required.
 */

/**
 * @param {string[]} allowedRoles - Array of roles that may access the route.
 *                                  Example: ['admin', 'super_admin']
 * @returns {import('express').RequestHandler}
 */
const checkRole = (allowedRoles) => (req, res, next) => {
    // req.user is populated by authenticateToken; guard against missing middleware.
    const userRole = req.user?.role;

    if (!userRole) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required. No role information found in token.',
        });
    }

    if (!allowedRoles.includes(userRole)) {
        return res.status(403).json({
            success: false,
            message: `Access denied. Required role(s): [${allowedRoles.join(', ')}]. Your role: ${userRole}.`,
        });
    }

    next();
};

module.exports = { checkRole };
