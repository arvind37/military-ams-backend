/**
 * RBAC Middleware
 * Roles: admin, base_commander, logistics_officer
 *
 * Admin          → full access to everything
 * Base Commander → access to their base only
 * Logistics      → purchases + transfers only (no assignments/expenditures write)
 */

// Allow only specific roles
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${roles.join(' or ')}`
      });
    }
    next();
  };
};

// Filter base access: admin sees all, others see only their base
const filterBase = (req, res, next) => {
  if (req.user.role === 'admin') {
    // Admin can filter by any base or see all
    next();
  } else {
    // Non-admins are locked to their own base
    req.forcedBaseId = req.user.base_id;
    next();
  }
};

module.exports = { authorize, filterBase };
