const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { filterBase } = require('../middleware/rbac');

// GET /api/dashboard
router.get('/', authenticate, filterBase, async (req, res) => {
  try {
    let { base_id, equipment_type_id, start_date, end_date } = req.query;
    if (req.forcedBaseId) base_id = req.forcedBaseId;

    const buildConditions = (baseField = 'base_id') => {
      const conds = [];
      const params = [];
      if (base_id) { conds.push(`${baseField} = $${params.length + 1}`); params.push(base_id); }
      if (equipment_type_id) { conds.push(`equipment_type_id = $${params.length + 1}`); params.push(equipment_type_id); }
      if (start_date) { conds.push(`created_at::date >= $${params.length + 1}`); params.push(start_date); }
      if (end_date) { conds.push(`created_at::date <= $${params.length + 1}`); params.push(end_date); }
      return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
    };

    const assetConds = [];
    const assetParams = [];
    if (base_id) { assetConds.push(`base_id = $${assetParams.length + 1}`); assetParams.push(base_id); }
    if (equipment_type_id) { assetConds.push(`equipment_type_id = $${assetParams.length + 1}`); assetParams.push(equipment_type_id); }
    const assetWhere = assetConds.length ? `WHERE ${assetConds.join(' AND ')}` : '';

    const openingRes = await pool.query(
      `SELECT COALESCE(SUM(opening_balance), 0)::int as total FROM assets ${assetWhere}`, assetParams
    );
    const closingRes = await pool.query(
      `SELECT COALESCE(SUM(current_balance), 0)::int as total FROM assets ${assetWhere}`, assetParams
    );

    const pFilter = buildConditions('base_id');
    const purchasesRes = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int as total FROM purchases ${pFilter.where}`, pFilter.params
    );

    const tiFilter = buildConditions('to_base_id');
    const transferInRes = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int as total FROM transfers ${tiFilter.where}`, tiFilter.params
    );

    const toFilter = buildConditions('from_base_id');
    const transferOutRes = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int as total FROM transfers ${toFilter.where}`, toFilter.params
    );

    const aFilter = buildConditions('base_id');
    const assignedRes = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int as total FROM assignments ${aFilter.where}`, aFilter.params
    );

    const eFilter = buildConditions('base_id');
    const expendedRes = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int as total FROM expenditures ${eFilter.where}`, eFilter.params
    );

    const purchases = purchasesRes.rows[0].total;
    const transferIn = transferInRes.rows[0].total;
    const transferOut = transferOutRes.rows[0].total;

    res.json({
      opening_balance: openingRes.rows[0].total,
      closing_balance: closingRes.rows[0].total,
      net_movement: purchases + transferIn - transferOut,
      purchases,
      transfer_in: transferIn,
      transfer_out: transferOut,
      assigned: assignedRes.rows[0].total,
      expended: expendedRes.rows[0].total
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/net-movement-details
router.get('/net-movement-details', authenticate, filterBase, async (req, res) => {
  try {
    let { base_id, equipment_type_id, start_date, end_date } = req.query;
    if (req.forcedBaseId) base_id = req.forcedBaseId;

    const buildFilter = (baseField) => {
      const conds = [];
      const params = [];
      if (base_id) { conds.push(`${baseField} = $${params.length + 1}`); params.push(base_id); }
      if (equipment_type_id) { conds.push(`equipment_type_id = $${params.length + 1}`); params.push(equipment_type_id); }
      if (start_date) { conds.push(`created_at::date >= $${params.length + 1}`); params.push(start_date); }
      if (end_date) { conds.push(`created_at::date <= $${params.length + 1}`); params.push(end_date); }
      return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
    };

    const pf = buildFilter('base_id');
    const purchases = await pool.query(
      `SELECT p.*, b.name as base_name, e.name as equipment_name
       FROM purchases p
       JOIN bases b ON p.base_id = b.id
       JOIN equipment_types e ON p.equipment_type_id = e.id
       ${pf.where} ORDER BY p.created_at DESC LIMIT 20`, pf.params
    );

    const tif = buildFilter('to_base_id');
    const transfersIn = await pool.query(
      `SELECT t.*, b1.name as from_base_name, b2.name as to_base_name, e.name as equipment_name
       FROM transfers t
       JOIN bases b1 ON t.from_base_id = b1.id
       JOIN bases b2 ON t.to_base_id = b2.id
       JOIN equipment_types e ON t.equipment_type_id = e.id
       ${tif.where} ORDER BY t.created_at DESC LIMIT 20`, tif.params
    );

    const tof = buildFilter('from_base_id');
    const transfersOut = await pool.query(
      `SELECT t.*, b1.name as from_base_name, b2.name as to_base_name, e.name as equipment_name
       FROM transfers t
       JOIN bases b1 ON t.from_base_id = b1.id
       JOIN bases b2 ON t.to_base_id = b2.id
       JOIN equipment_types e ON t.equipment_type_id = e.id
       ${tof.where} ORDER BY t.created_at DESC LIMIT 20`, tof.params
    );

    res.json({
      purchases: purchases.rows,
      transfers_in: transfersIn.rows,
      transfers_out: transfersOut.rows
    });
  } catch (err) {
    console.error('Net movement details error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
