const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { authorize, filterBase } = require('../middleware/rbac');
const { auditLog } = require('../middleware/auditLogger');

// ─── ASSIGNMENTS ────────────────────────────────────────────

// GET /api/assignments
router.get('/', authenticate, filterBase, async (req, res) => {
  try {
    let { base_id, equipment_type_id, start_date, end_date } = req.query;
    if (req.forcedBaseId) base_id = req.forcedBaseId;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (base_id) { conditions.push(`a.base_id = $${idx++}`); params.push(base_id); }
    if (equipment_type_id) { conditions.push(`a.equipment_type_id = $${idx++}`); params.push(equipment_type_id); }
    if (start_date) { conditions.push(`a.assignment_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { conditions.push(`a.assignment_date <= $${idx++}`); params.push(end_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT a.*,
              b.name as base_name,
              e.name as equipment_name,
              e.category as equipment_category,
              u.name as created_by_name
       FROM assignments a
       JOIN bases b ON a.base_id = b.id
       JOIN equipment_types e ON a.equipment_type_id = e.id
       LEFT JOIN users u ON a.created_by = u.id
       ${where}
       ORDER BY a.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/assignments - admin and base_commander only
router.post(
  '/',
  authenticate,
  authorize('admin', 'base_commander'),
  async (req, res) => {
    const { base_id, equipment_type_id, personnel_name, quantity, assignment_date, notes } = req.body;

    if (!base_id || !equipment_type_id || !personnel_name || !quantity) {
      return res.status(400).json({ error: 'base_id, equipment_type_id, personnel_name, and quantity are required' });
    }

    if (req.user.role === 'base_commander' && req.user.base_id !== base_id) {
      return res.status(403).json({ error: 'You can only assign assets at your own base' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check balance
      const assetResult = await client.query(
        `SELECT current_balance FROM assets WHERE base_id = $1 AND equipment_type_id = $2`,
        [base_id, equipment_type_id]
      );

      if (!assetResult.rows[0] || assetResult.rows[0].current_balance < quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient balance. Available: ${assetResult.rows[0]?.current_balance || 0}`
        });
      }

      const assignResult = await client.query(
        `INSERT INTO assignments (base_id, equipment_type_id, personnel_name, quantity, assignment_date, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [base_id, equipment_type_id, personnel_name, quantity, assignment_date || new Date(), notes, req.user.id]
      );

      const assignment = assignResult.rows[0];

      // Deduct from balance
      await client.query(
        `UPDATE assets SET current_balance = current_balance - $1
         WHERE base_id = $2 AND equipment_type_id = $3`,
        [quantity, base_id, equipment_type_id]
      );

      await client.query('COMMIT');

      await auditLog({
        userId: req.user.id,
        action: 'ASSIGN',
        entityType: 'assignments',
        entityId: assignment.id,
        payload: { base_id, equipment_type_id, personnel_name, quantity }
      });

      res.status(201).json(assignment);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
    }
  }
);

// PATCH /api/assignments/:id/status
router.patch(
  '/:id/status',
  authenticate,
  authorize('admin', 'base_commander'),
  async (req, res) => {
    const { status } = req.body;
    if (!['active', 'returned', 'expended'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    try {
      const result = await pool.query(
        `UPDATE assignments SET status = $1 WHERE id = $2 RETURNING *`,
        [status, req.params.id]
      );

      if (status === 'returned') {
        const a = result.rows[0];
        await pool.query(
          `UPDATE assets SET current_balance = current_balance + $1
           WHERE base_id = $2 AND equipment_type_id = $3`,
          [a.quantity, a.base_id, a.equipment_type_id]
        );
      }

      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ─── EXPENDITURES ────────────────────────────────────────────

// GET /api/assignments/expenditures
router.get('/expenditures', authenticate, filterBase, async (req, res) => {
  try {
    let { base_id, equipment_type_id, start_date, end_date } = req.query;
    if (req.forcedBaseId) base_id = req.forcedBaseId;

    const conditions = [];
    const params = [];
    let idx = 1;

    if (base_id) { conditions.push(`e.base_id = $${idx++}`); params.push(base_id); }
    if (equipment_type_id) { conditions.push(`e.equipment_type_id = $${idx++}`); params.push(equipment_type_id); }
    if (start_date) { conditions.push(`e.expenditure_date >= $${idx++}`); params.push(start_date); }
    if (end_date) { conditions.push(`e.expenditure_date <= $${idx++}`); params.push(end_date); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `SELECT e.*,
              b.name as base_name,
              eq.name as equipment_name,
              eq.category as equipment_category,
              u.name as created_by_name
       FROM expenditures e
       JOIN bases b ON e.base_id = b.id
       JOIN equipment_types eq ON e.equipment_type_id = eq.id
       LEFT JOIN users u ON e.created_by = u.id
       ${where}
       ORDER BY e.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/assignments/expenditures
router.post(
  '/expenditures',
  authenticate,
  authorize('admin', 'base_commander'),
  async (req, res) => {
    const { base_id, equipment_type_id, quantity, expenditure_date, reason } = req.body;

    if (!base_id || !equipment_type_id || !quantity) {
      return res.status(400).json({ error: 'base_id, equipment_type_id, and quantity are required' });
    }

    if (req.user.role === 'base_commander' && req.user.base_id !== base_id) {
      return res.status(403).json({ error: 'You can only record expenditures for your own base' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const assetResult = await client.query(
        `SELECT current_balance FROM assets WHERE base_id = $1 AND equipment_type_id = $2`,
        [base_id, equipment_type_id]
      );

      if (!assetResult.rows[0] || assetResult.rows[0].current_balance < quantity) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Insufficient balance. Available: ${assetResult.rows[0]?.current_balance || 0}`
        });
      }

      const expendResult = await client.query(
        `INSERT INTO expenditures (base_id, equipment_type_id, quantity, expenditure_date, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [base_id, equipment_type_id, quantity, expenditure_date || new Date(), reason, req.user.id]
      );

      const expenditure = expendResult.rows[0];

      await client.query(
        `UPDATE assets SET current_balance = current_balance - $1
         WHERE base_id = $2 AND equipment_type_id = $3`,
        [quantity, base_id, equipment_type_id]
      );

      await client.query('COMMIT');

      await auditLog({
        userId: req.user.id,
        action: 'EXPEND',
        entityType: 'expenditures',
        entityId: expenditure.id,
        payload: { base_id, equipment_type_id, quantity, reason }
      });

      res.status(201).json(expenditure);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    } finally {
      client.release();
    }
  }
);

// GET /api/assignments/audit-logs - admin only
router.get('/audit-logs', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT al.*, u.name as user_name, u.email as user_email, u.role as user_role
       FROM audit_logs al
       LEFT JOIN users u ON al.user_id = u.id
       ORDER BY al.created_at DESC
       LIMIT 100`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
