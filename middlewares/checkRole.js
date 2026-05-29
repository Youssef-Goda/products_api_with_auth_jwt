/**
 * checkRole.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Role-Based Access Control (RBAC) middleware for the Dealio API.
 *
 * Five roles (ascending privilege):
 *   customer < vendor < moderator < admin < owner
 *
 * Usage (always chain AFTER authenticateToken):
 *   router.post('/add', authenticateToken, checkRole(['admin', 'owner']), handler);
 *   router.patch('/ban', authenticateToken, checkRole(['admin','owner']), ownerPrivilege, handler);
 *   router.get('/reports', authenticateToken, checkMinRole('moderator'), handler);
 */

// ── Supabase admin client factory (lazy — created on first use) ─────────────
let _supabaseAdmin = null;
const getSupabaseAdmin = () => {
  if (!_supabaseAdmin) {
    const { createClient } = require('@supabase/supabase-js');
    _supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
    );
  }
  return _supabaseAdmin;
};

// ── Role hierarchy ─────────────────────────────────────────────────────────────
const ROLE_HIERARCHY = {
  owner:     5,
  admin:     4,
  moderator: 3,
  vendor:    2,
  customer:  1,
  user:      1, // legacy alias for customer
};

/**
 * Standard role whitelist check.
 * Pass an array of roles that are permitted to access the route.
 *
 * @param {string[]} allowedRoles
 * @returns {import('express').RequestHandler}
 */
const checkRole = (allowedRoles) => (req, res, next) => {
  const userRole = req.user?.role;

  if (!userRole) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. No role information found in token.',
    });
  }

  // Owner always bypasses all role checks
  if (userRole === 'owner') {
    return next();
  }

  if (!allowedRoles.includes(userRole)) {
    return res.status(403).json({
      success: false,
      message: `Access denied. Required role(s): [${allowedRoles.join(', ')}]. Your role: ${userRole}.`,
    });
  }

  next();
};

/**
 * Hierarchy-based check: user must have AT LEAST the given role level.
 * Allows the specified role AND all higher roles automatically.
 *
 * Example: checkMinRole('moderator') → allows moderator, admin, owner
 *
 * @param {string} minRole
 * @returns {import('express').RequestHandler}
 */
const checkMinRole = (minRole) => (req, res, next) => {
  const userLevel = ROLE_HIERARCHY[req.user?.role] ?? 0;
  const required  = ROLE_HIERARCHY[minRole] ?? 999;

  if (userLevel < required) {
    return res.status(403).json({
      success: false,
      message: `Insufficient privileges. Minimum required role: ${minRole}. Your role: ${req.user?.role}.`,
    });
  }

  next();
};

/**
 * Owner Privilege guard.
 *
 * Rejects any attempt by a non-owner actor to mutate an owner account.
 * Place this AFTER checkRole(['admin', 'owner']) on all user-mutation endpoints.
 *
 * The target user id must be in req.params.id  (standard REST convention).
 * If req.targetUser is pre-populated (e.g. by a prior findById middleware),
 * no extra DB lookup is performed.
 *
 * @type {import('express').RequestHandler}
 */
const ownerPrivilege = async (req, res, next) => {
  // If the actor IS the owner, always allow (owners can manage other owners)
  if (req.user?.role === 'owner') return next();

  try {
    // Prefer pre-loaded target to avoid extra DB call
    let targetRole = req.targetUser?.role;

    if (!targetRole && req.params.id) {
      const { data, error } = await getSupabaseAdmin()
        .from('users')
        .select('role')
        .eq('id', req.params.id)
        .single();

      if (error || !data) {
        return res.status(404).json({ success: false, message: 'Target user not found.' });
      }
      targetRole = data.role;
    }

    if (targetRole === 'owner') {
      return res.status(403).json({
        success: false,
        message: 'The Owner account cannot be modified or banned by another role.',
      });
    }

    next();
  } catch (err) {
    console.error('ownerPrivilege error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
};

module.exports = { checkRole, checkMinRole, ownerPrivilege, ROLE_HIERARCHY };
