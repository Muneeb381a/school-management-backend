const db = require('../db');
const AppError = require('../utils/AppError');

// GET /api/billing/plans  — public, lists available plans
async function getPlans(req, res) {
  const { rows } = await db.raw.query(
    `SELECT id, name, price_monthly, price_yearly, max_students, max_teachers, features
     FROM public.subscription_plans WHERE active = true ORDER BY price_monthly`
  );
  res.json({ success: true, data: rows });
}

// GET /api/billing/subscription  — current school's subscription
async function getSubscription(req, res) {
  const schema = req.schema;
  const { rows: [sub] } = await db.raw.query(
    `SELECT ss.*, sp.name AS plan_name, sp.price_monthly, sp.max_students, sp.features
     FROM public.school_subscriptions ss
     JOIN public.subscription_plans sp ON sp.id = ss.plan_id
     WHERE ss.school_id = (SELECT id FROM public.schools WHERE schema_name = $1)`,
    [schema]
  );
  res.json({ success: true, data: sub || null });
}

// GET /api/billing/payments  — payment history
async function getPayments(req, res) {
  const { limit = 20, offset = 0 } = req.query;
  const schema = req.schema;
  const { rows } = await db.raw.query(
    `SELECT sp.*
     FROM public.subscription_payments sp
     WHERE sp.school_id = (SELECT id FROM public.schools WHERE schema_name = $1)
     ORDER BY sp.created_at DESC
     LIMIT $2 OFFSET $3`,
    [schema, +limit, +offset]
  );
  res.json({ success: true, data: rows });
}

// POST /api/billing/upgrade  — request plan upgrade
async function requestUpgrade(req, res) {
  const { plan_id } = req.body;
  if (!plan_id) throw new AppError('plan_id is required', 400);
  const schema = req.schema;
  const { rows: [plan] } = await db.raw.query(
    `SELECT * FROM public.subscription_plans WHERE id = $1 AND active = true`, [plan_id]
  );
  if (!plan) throw new AppError('Plan not found', 404);
  // In a real system this would integrate with JazzCash/EasyPaisa
  // For now just record the request
  const { rows: [school] } = await db.raw.query(
    `SELECT id FROM public.schools WHERE schema_name = $1`, [schema]
  );
  await db.raw.query(
    `INSERT INTO public.subscription_payments (school_id, plan_id, amount, status, notes, created_at)
     VALUES ($1, $2, $3, 'pending', 'upgrade_request', NOW())`,
    [school.id, plan_id, plan.price_monthly]
  );
  res.json({ success: true, message: 'Upgrade request submitted. Our team will contact you shortly.' });
}

module.exports = { getPlans, getSubscription, getPayments, requestUpgrade };
