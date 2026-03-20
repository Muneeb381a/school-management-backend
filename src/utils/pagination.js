/**
 * Pagination utility — keeps all list endpoints consistent.
 *
 * Usage in a controller:
 *   const { page, limit, offset } = parsePagination(req.query);
 *   const countRes = await pool.query(`SELECT COUNT(*) FROM students WHERE ...`, params);
 *   const dataRes  = await pool.query(`SELECT ... LIMIT $N OFFSET $M`, [...params, limit, offset]);
 *   res.json({ success: true, data: dataRes.rows, meta: paginationMeta(total, page, limit) });
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;

/**
 * Parse safe page/limit/offset from request query params.
 */
function parsePagination(query = {}) {
  const page   = Math.max(1, parseInt(query.page,  10) || 1);
  const limit  = Math.min(MAX_LIMIT, Math.max(1, parseInt(query.limit, 10) || DEFAULT_LIMIT));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * Append LIMIT / OFFSET placeholders to a SQL string.
 * Returns a new { query, params } pair — originals are untouched.
 *
 * @param {string}   baseQuery     SQL ending before LIMIT
 * @param {Array}    existingParams  Current positional params
 * @param {{ limit, offset }}  pagination  From parsePagination()
 */
function applyPagination(baseQuery, existingParams, { limit, offset }) {
  const params = [...existingParams, limit, offset];
  const query  = `${baseQuery} LIMIT $${params.length - 1} OFFSET $${params.length}`;
  return { query, params };
}

/**
 * Build a consistent pagination meta object for API responses.
 */
function paginationMeta(total, page, limit) {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

module.exports = { parsePagination, applyPagination, paginationMeta };
