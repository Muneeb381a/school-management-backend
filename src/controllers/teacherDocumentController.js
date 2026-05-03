const pool        = require('../db');
const { serverErr } = require('../utils/serverErr');

/* ── helpers ── */
const notFound = (res, msg = 'Not found') => res.status(404).json({ success: false, message: msg });

const fmtDate = (d) => {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('en-PK', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch { return String(d); }
};

const fmtCurrency = (n) =>
  n != null ? 'PKR ' + Number(n).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '';

// Replace every {token} in the template body
function applyTokens(html, tokens) {
  return html.replace(/\{(\w+)\}/g, (_, key) => (tokens[key] != null ? String(tokens[key]) : `{${key}}`));
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/teachers/letter-templates
// ─────────────────────────────────────────────────────────────────────────────
const getTemplates = async (req, res) => {
  try {
    const { doc_type, is_active } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (doc_type) { params.push(doc_type); where += ` AND doc_type = $${params.length}`; }
    if (is_active !== undefined) { params.push(is_active !== 'false'); where += ` AND is_active = $${params.length}`; }

    const { rows } = await pool.query(
      `SELECT id, title, doc_type, subject_line, is_active, created_at, updated_at
       FROM letter_templates ${where} ORDER BY doc_type, title`,
      params
    );
    res.json({ success: true, data: rows });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/teachers/letter-templates/:id
// ─────────────────────────────────────────────────────────────────────────────
const getTemplate = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM letter_templates WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) return notFound(res, 'Template not found');
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/teachers/letter-templates
// ─────────────────────────────────────────────────────────────────────────────
const createTemplate = async (req, res) => {
  try {
    const { title, doc_type = 'custom', subject_line, body } = req.body;
    if (!title?.trim()) return res.status(400).json({ success: false, message: 'Title is required' });
    if (!body?.trim())  return res.status(400).json({ success: false, message: 'Body is required' });

    const { rows } = await pool.query(
      `INSERT INTO letter_templates (title, doc_type, subject_line, body, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [title.trim(), doc_type, subject_line || null, body, req.user?.id || null]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /api/teachers/letter-templates/:id
// ─────────────────────────────────────────────────────────────────────────────
const updateTemplate = async (req, res) => {
  try {
    const { title, doc_type, subject_line, body, is_active } = req.body;
    const { rows: exist } = await pool.query(
      'SELECT id FROM letter_templates WHERE id=$1', [req.params.id]
    );
    if (!exist[0]) return notFound(res, 'Template not found');

    const { rows } = await pool.query(
      `UPDATE letter_templates
       SET title=$1, doc_type=$2, subject_line=$3, body=$4, is_active=$5, updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [
        title?.trim() || exist[0].title,
        doc_type      || exist[0].doc_type,
        subject_line  ?? exist[0].subject_line,
        body          || exist[0].body,
        is_active     ?? exist[0].is_active,
        req.params.id,
      ]
    );
    res.json({ success: true, data: rows[0] });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /api/teachers/letter-templates/:id
// ─────────────────────────────────────────────────────────────────────────────
const deleteTemplate = async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM letter_templates WHERE id=$1', [req.params.id]
    );
    if (!rowCount) return notFound(res, 'Template not found');
    res.json({ success: true, message: 'Template deleted' });
  } catch (err) { serverErr(res, err); }
};

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/teachers/:id/generate-document
//  Body: { template_id, overrides: { from_date, to_date, issue_date, principal_name } }
//  Returns: rendered HTML ready for print/PDF
// ─────────────────────────────────────────────────────────────────────────────
const generateDocument = async (req, res) => {
  try {
    const teacherId   = req.params.id;
    const { template_id, overrides = {} } = req.body;

    if (!template_id) return res.status(400).json({ success: false, message: 'template_id is required' });

    // Parallel fetch: teacher + template + settings
    const [teacherRes, templateRes, settingsRes] = await Promise.all([
      pool.query(
        `SELECT t.*,
                u.username
         FROM teachers t
         LEFT JOIN users u ON u.entity_id = t.id AND u.role = 'teacher'
         WHERE t.id = $1 AND t.deleted_at IS NULL`,
        [teacherId]
      ),
      pool.query('SELECT * FROM letter_templates WHERE id=$1 AND is_active=TRUE', [template_id]),
      pool.query(
        `SELECT key, value FROM settings
         WHERE key IN ('school_name','school_address','school_phone','school_email','principal_name')`,
      ),
    ]);

    const teacher  = teacherRes.rows[0];
    const template = templateRes.rows[0];

    if (!teacher)  return notFound(res, 'Teacher not found');
    if (!template) return notFound(res, 'Template not found or inactive');

    // Build settings map
    const cfg = {};
    settingsRes.rows.forEach(r => { cfg[r.key] = r.value; });

    const today = new Date();

    const tokens = {
      // Teacher fields
      name:          teacher.full_name || '',
      designation:   teacher.designation || '',
      employee_id:   teacher.employee_id || '',
      salary:        teacher.salary != null ? fmtCurrency(teacher.salary) : '',
      join_date:     fmtDate(teacher.join_date),
      subject:       teacher.subject || '',
      qualification: teacher.qualification || '',
      phone:         teacher.phone || '',
      email:         teacher.email || '',
      username:      teacher.username || '',

      // School / config fields
      school_name:    cfg.school_name    || 'School Management System',
      school_address: cfg.school_address || '',
      school_phone:   cfg.school_phone   || '',
      principal_name: cfg.principal_name || 'Principal',

      // Date fields — overrides take priority
      issue_date: fmtDate(overrides.issue_date || today),
      from_date:  fmtDate(overrides.from_date  || teacher.join_date || today),
      to_date:    fmtDate(overrides.to_date    || today),

      // Manual overrides can also supply name, designation, etc.
      ...Object.fromEntries(
        Object.entries(overrides)
          .filter(([, v]) => v != null && v !== '')
          .map(([k, v]) => [k, k.endsWith('_date') ? fmtDate(v) : v])
      ),
    };

    const rendered = applyTokens(template.body, tokens);

    // Build print-page wrapper (letterhead outer shell)
    const pageHtml = buildPrintPage({
      schoolName: tokens.school_name,
      schoolAddress: tokens.school_address,
      schoolPhone: tokens.school_phone,
      docTitle: applyTokens(template.subject_line || template.title, tokens),
      body: rendered,
    });

    res.json({
      success: true,
      data: {
        html:        pageHtml,
        subject_line: applyTokens(template.subject_line || template.title, tokens),
        doc_type:    template.doc_type,
        teacher_name: teacher.full_name,
      },
    });
  } catch (err) { serverErr(res, err); }
};

// ── Letterhead shell — wraps the template body with a school header ──
function buildPrintPage({ schoolName, schoolAddress, schoolPhone, docTitle, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${docTitle}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #111; background: #fff; }
  @media print {
    @page { size: A4; margin: 18mm 20mm; }
    body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    .no-print { display: none !important; }
  }
  .letterhead {
    border-bottom: 3px solid #1e3a5f;
    padding-bottom: 12px;
    margin-bottom: 24px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
  }
  .school-name { font-size: 20px; font-weight: 800; color: #1e3a5f; text-transform: uppercase; }
  .school-meta { font-size: 11px; color: #555; line-height: 1.5; text-align: right; }
  .doc-title {
    font-size: 15px;
    font-weight: 700;
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #1e3a5f;
    margin-bottom: 20px;
    padding-bottom: 8px;
    border-bottom: 1px solid #ddd;
  }
  .body-wrap { padding: 0 8px; }
</style>
</head>
<body>
<div style="max-width:740px;margin:auto;padding:32px 40px">
  <div class="letterhead">
    <div class="school-name">${schoolName}</div>
    <div class="school-meta">
      ${schoolAddress ? schoolAddress + '<br/>' : ''}
      ${schoolPhone   ? 'Tel: ' + schoolPhone   : ''}
    </div>
  </div>
  <div class="doc-title">${docTitle}</div>
  <div class="body-wrap">${body}</div>
</div>
</body>
</html>`;
}

module.exports = {
  getTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  generateDocument,
};
