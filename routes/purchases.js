const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { authorize, filterBase } = require('../middleware/rbac');
const { auditLog } = require('../middleware/auditLogger');

// GET /api/purchases - list all purchases with filters
router.get('/', authenticate, filterBase, async (req, res) => {
  try {
    let { base_id, equipment_type_id, start_date, end_date } = req.query;
    if (req.forcedBaseId) base_id = req.forcedBaseId;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (base_id) { conditions.push(`p.base_id = $${idx++}`); params.push(base_id); }
    if (equipment_type_id) { conditions.push(`p.equipment_type_id = $${idx++}`); params.push(equipment_type_id); }
    if (start_date) { conditions.push(`p.purchase_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { conditions.push(`p.purchase_date <= $${idx++}`); params.push(end_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT p.*, 
              b.name as base_name, 
              e.name as equipment_name, 
              e.category as equipment_category,
              u.name as created_by_name
       FROM purchases p
       JOIN bases b ON p.base_id = b.id
       JOIN equipment_types e ON p.equipment_type_id = e.id
       LEFT JOIN users u ON p.created_by = u.id
       ${where}
       ORDER BY p.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/purchases - create a purchase
// Admin and logistics_officer can create; base_commander can for their base
router.post(
  '/',
  authenticate,
  authorize('admin', 'base_commander', 'logistics_officer'),
  async (req, res) => {
    const { base_id, equipment_type_id, quantity, purchase_date, notes } = req.body;

    if (!base_id || !equipment_type_id || !quantity) {
      return res.status(400).json({ error: 'base_id, equipment_type_id, and quantity are required' });
    }

    // Base commander can only purchase for their own base
    if (req.user.role === 'base_commander' && req.user.base_id !== base_id) {
      return res.status(403).json({ error: 'You can only make purchases for your own base' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert purchase record
      const purchaseResult = await client.query(
        `INSERT INTO purchases (base_id, equipment_type_id, quantity, purchase_date, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [base_id, equipment_type_id, quantity, purchase_date || new Date(), notes, req.user.id]
      );

      const purchase = purchaseResult.rows[0];

      // Update asset balance (upsert)
      await client.query(
        `INSERT INTO assets (base_id, equipment_type_id, opening_balance, current_balance)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (base_id, equipment_type_id)
         DO UPDATE SET current_balance = assets.current_balance + $3`,
        [base_id, equipment_type_id, quantity]
      );

      await client.query('COMMIT');

      // Audit log
      await auditLog({
        userId: req.user.id,
        action: 'PURCHASE',
        entityType: 'purchases',
        entityId: purchase.id,
        payload: { base_id, equipment_type_id, quantity, purchase_date, notes }
      });

      res.status(201).json(purchase);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
    }
  }
);

// DELETE /api/purchases/:id - admin only
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM purchases WHERE id = $1', [req.params.id]);
    res.json({ message: 'Purchase deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
