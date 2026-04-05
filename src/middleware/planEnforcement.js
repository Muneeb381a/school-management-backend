const db = require('../db');
const AppError = require('../utils/AppError');

// Cache plan limits per schema for 5 minutes
const cache = new Map();
const TTL = 5 * 60 * 1000;

async function getPlanLimits(schema) {
  const cached = cache.get(schema);
  if (cached && Date.now() - cached.ts < TTL) return cached.data;

  try {
    const { rows: [row] } = await db.raw.query(
      `SELECT sp.max_students, sp.max_teachers, sp.features
       FROM public.school_subscriptions ss
       JOIN public.subscription_plans sp ON sp.id = ss.plan_id
       WHERE ss.school_id = (SELECT id FROM public.schools WHERE schema_name = $1)
         AND ss.status = 'active'`,
      [schema]
    );
    const data = row || { max_students: 200, max_teachers: 20, features: [] };
    cache.set(schema, { data, ts: Date.now() });
    return data;
  } catch {
    // If table doesn't exist yet, allow everything
    return { max_students: 9999, max_teachers: 9999, features: [] };
  }
}

/**
 * Enforce max student limit.
 * Usage: router.post('/', enforceStudentLimit, handler)
 */
function enforceStudentLimit(req, res, next) {
  const schema = req.user?.schema;
  if (!schema) return next();

  getPlanLimits(schema).then(async (limits) => {
    try {
      const { rows: [{ count }] } = await db.query(`SELECT COUNT(*) FROM students WHERE status = 'active'`);
      if (+count >= limits.max_students) {
        return next(new AppError(
          `Student limit reached (${limits.max_students}). Please upgrade your plan.`,
          403,
          'PLAN_LIMIT_EXCEEDED'
        ));
      }
      next();
    } catch { next(); }
  }).catch(() => next());
}

/**
 * Enforce max teacher limit.
 */
function enforceTeacherLimit(req, res, next) {
  const schema = req.user?.schema;
  if (!schema) return next();

  getPlanLimits(schema).then(async (limits) => {
    try {
      const { rows: [{ count }] } = await db.query(`SELECT COUNT(*) FROM teachers WHERE status = 'active'`);
      if (+count >= limits.max_teachers) {
        return next(new AppError(
          `Teacher limit reached (${limits.max_teachers}). Please upgrade your plan.`,
          403,
          'PLAN_LIMIT_EXCEEDED'
        ));
      }
      next();
    } catch { next(); }
  }).catch(() => next());
}

/**
 * Check if a specific feature is enabled on the plan.
 * Usage: router.post('/bulk', requireFeature('whatsapp_bulk'), handler)
 */
function requireFeature(featureKey) {
  return (req, res, next) => {
    const schema = req.user?.schema;
    if (!schema) return next();

    getPlanLimits(schema).then((limits) => {
      const features = Array.isArray(limits.features) ? limits.features : [];
      if (!features.includes(featureKey)) {
        return next(new AppError(
          `This feature (${featureKey}) requires a higher plan. Please upgrade.`,
          403,
          'FEATURE_NOT_AVAILABLE'
        ));
      }
      next();
    }).catch(() => next());
  };
}

module.exports = { enforceStudentLimit, enforceTeacherLimit, requireFeature };
