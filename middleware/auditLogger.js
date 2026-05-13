const pool = require('../config/db');

/**
 * Log any transaction to audit_logs table
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.action - e.g. 'PURCHASE', 'TRANSFER', 'ASSIGN', 'EXPEND'
 * @param {string} params.entityType - e.g. 'purchases', 'transfers'
 * @param {string} params.entityId - UUID of created record
 * @param {object} params.payload - full request body snapshot
 */
const auditLog = async ({ userId, action, entityType, entityId, payload }) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, action, entityType, entityId, JSON.stringify(payload)]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
};

module.exports = { auditLog };
