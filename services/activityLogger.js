const ActivityLog = require('../models/ActivityLog');

/**
 * Log activity to the database.
 * 
 * @param {string|null} userId - The ID of the user performing the action.
 * @param {string} action - The action name (e.g. 'CREATE_PRODUCT').
 * @param {string} entityType - The entity type (e.g. 'product').
 * @param {string|null} entityId - The ID of the modified entity.
 * @param {object|null} details - Any metadata or diff object.
 */
async function logActivity(userId, action, entityType, entityId, details) {
  try {
    await ActivityLog.create({
      userId: userId || null,
      action,
      entityType,
      entityId: entityId ? String(entityId) : null,
      details: details || null,
    });
    console.log(`📝 [ActivityLog] ${action} logged.`);
  } catch (err) {
    console.error(`❌ [ActivityLog] Error creating activity log:`, err.message);
  }
}

module.exports = { logActivity };
