const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { authorize, filterBase } = require('../middleware/rbac');
const { auditLog } = require('../middleware/auditLogger');

// GET /api/transfers
router.get('/', authenticate, filterBase, async (req, res) => {
  try {
    let { base_id, equipment_type_id, start_date, end_date } = req.query;
    if (req.forcedBaseId) base_id = req.forcedBaseId;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (base_id) {
      conditions.push(`(t.from_base_id = $${idx} OR t.to_base_id = $${idx})`);
      params.push(base_id);
      idx++;
    }
    if (equipment_type_id) { conditions.push(`t.equipment_type_id = $${idx++}`); params.push(equipment_type_id); }
    if (start_date) { conditions.push(`t.transfer_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { conditions.push(`t.transfer_date <= $${idx++}`); params.push(end_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT t.*,
              b1.name as from_base_name,
              b2.name as to_base_name,
              e.name as equipment_name,
              e.category as equipment_category,
              u.name as created_by_name
       FROM transfers t
       JOIN bases b1 ON t.from_base_id = b1.id
       JOIN bases b2 ON t.to_base_id = b2.id
       JOIN equipment_types e ON t.equipment_type_id = e.id
       LEFT JOIN users u ON t.created_by = u.id
       ${where}
       ORDER BY t.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/transfers
router.post(
  '/',
  authenticate,
  authorize('admin', 'base_commander', 'logistics_officer'),
  async (req, res) => {
    const { from_base_id, to_base_id, equipment_type_id, quantity, transfer_date, notes } = req.body;

    if (!from_base_id || !to_base_id || !equipment_type_id || !quantity) {
      return res.status(400).json({ error: 'from_base_id, to_base_id, equipment_type_id, and quantity are required' });
    }

    if (from_base_id === to_base_id) {
      return res.status(400).json({ error: 'Source and destination bases must be different' });
    }

    // Base commander can only transfer FROM their base
    if (req.user.role === 'base_commander' && req.user.base_id !== from_base_id) {
      return res.status(403).json({ error: 'You can only transfer from your own base' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check source balance
      const assetResult = await client.query(
        `SELECT current_balance FROM assets 
         WHERE base_id = $1 AND equipment_type_id = $2`,
        [from_base_id, equipment_type_id]
      );

      if (!assetResult.rows[0] || assetResult.rows[0].current_balance < quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient balance. Available: ${assetResult.rows[0]?.current_balance || 0}`
        });
      }

      // Insert transfer
      const transferResult = await client.query(
        `INSERT INTO transfers (from_base_id, to_base_id, equipment_type_id, quantity, transfer_date, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [from_base_id, to_base_id, equipment_type_id, quantity, transfer_date || new Date(), notes, req.user.id]
      );

      const transfer = transferResult.rows[0];

      // Deduct from source
      await client.query(
        `UPDATE assets SET current_balance = current_balance - $1
         WHERE base_id = $2 AND equipment_type_id = $3`,
        [quantity, from_base_id, equipment_type_id]
      );

      // Add to destination (upsert)
      await client.query(
        `INSERT INTO assets (base_id, equipment_type_id, opening_balance, current_balance)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (base_id, equipment_type_id)
         DO UPDATE SET current_balance = assets.current_balance + $3`,
        [to_base_id, equipment_type_id, quantity]
      );

      await client.query('COMMIT');

      await auditLog({
        userId: req.user.id,
        action: 'TRANSFER',
        entityType: 'transfers',
        entityId: transfer.id,
        payload: { from_base_id, to_base_id, equipment_type_id, quantity, transfer_date, notes }
      });

      res.status(201).json(transfer);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
