/**
 * Lightweight input validation middleware — no external dependencies.
 *
 * Usage:
 *   router.post('/', validate([
 *     { field: 'email',    required: true,  type: 'email' },
 *     { field: 'name',     required: true,  type: 'string', min: 2, max: 100 },
 *     { field: 'age',      required: false, type: 'integer', min: 0, max: 120 },
 *     { field: 'amount',   required: true,  type: 'number', min: 0 },
 *   ]), controller);
 *
 * Side-effect: trims string values and coerces integer/number/boolean fields in req.body.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pakistani mobile: 03XX-XXXXXXX | 03XXXXXXXXX | +923XXXXXXXXX | 00923XXXXXXXXX
const PK_PHONE_RE = /^(\+92|0092|0)3[0-9]{9}$/;
// Generic international fallback (kept for non-PK numbers)
const PHONE_RE    = /^[+\d\s\-().]{7,20}$/;

// NADRA CNIC / B-Form format: XXXXX-XXXXXXX-X
const CNIC_RE = /^\d{5}-\d{7}-\d{1}$/;

/**
 * @param {Array<{
 *   field:    string,
 *   label?:   string,     // Human-friendly name for error messages
 *   required?: boolean,
 *   type?:    'string'|'integer'|'number'|'email'|'phone'|'boolean'|'date',
 *   min?:     number,     // min length (strings) or min value (numbers)
 *   max?:     number,
 *   pattern?: RegExp,
 *   custom?:  (value) => string|null   // return error string or null
 * }>} rules
 */
function validate(rules) {
  return (req, _res, next) => {
    const errors = [];
    const body   = req.body || {};

    for (const rule of rules) {
      const { field, label, required, type, min, max, pattern, custom } = rule;
      const name = label || field;
      let   val  = body[field];

      // Trim all incoming strings first (sanitize whitespace)
      if (typeof val === 'string') {
        val = val.trim();
        body[field] = val;
      }

      const isEmpty = val === undefined || val === null || val === '';

      // Required check
      if (required && isEmpty) {
        errors.push(`${name} is required.`);
        continue;
      }

      // Skip further checks if the field is absent/empty and not required
      if (isEmpty) continue;

      // Type-specific validation & coercion
      switch (type) {
        case 'email':
          if (!EMAIL_RE.test(val))
            errors.push(`${name} must be a valid email address.`);
          break;

        case 'phone':
          if (!PHONE_RE.test(val))
            errors.push(`${name} must be a valid phone number.`);
          break;

        case 'pk_phone':
          // Strip spaces/dashes for normalization before check
          if (!PK_PHONE_RE.test(val.replace(/[\s\-]/g, '')))
            errors.push(`${name} must be a valid Pakistani mobile number (e.g. 03001234567).`);
          break;

        case 'cnic':
          if (!CNIC_RE.test(val))
            errors.push(`${name} must be in NADRA format: XXXXX-XXXXXXX-X.`);
          break;

        case 'string':
          if (min !== undefined && val.length < min)
            errors.push(`${name} must be at least ${min} characters.`);
          if (max !== undefined && val.length > max)
            errors.push(`${name} must be no more than ${max} characters.`);
          break;

        case 'integer': {
          const n = parseInt(val, 10);
          if (isNaN(n) || String(n) !== String(val).trim()) {
            errors.push(`${name} must be a whole number.`);
          } else {
            if (min !== undefined && n < min) errors.push(`${name} must be at least ${min}.`);
            if (max !== undefined && n > max) errors.push(`${name} must be at most ${max}.`);
            body[field] = n; // coerce
          }
          break;
        }

        case 'number': {
          const n = parseFloat(val);
          if (isNaN(n)) {
            errors.push(`${name} must be a number.`);
          } else {
            if (min !== undefined && n < min) errors.push(`${name} must be at least ${min}.`);
            if (max !== undefined && n > max) errors.push(`${name} must be at most ${max}.`);
            body[field] = n; // coerce
          }
          break;
        }

        case 'boolean':
          body[field] = val === true || val === 'true' || val === 1 || val === '1';
          break;

        case 'date':
          if (isNaN(Date.parse(val)))
            errors.push(`${name} must be a valid date.`);
          break;
      }

      // Pattern check
      if (pattern && !pattern.test(val))
        errors.push(`${name} format is invalid.`);

      // Custom validator
      if (custom) {
        const msg = custom(val);
        if (msg) errors.push(msg);
      }
    }

    if (errors.length > 0) {
      return _res.status(400).json({
        success: false,
        message: 'Validation failed.',
        code:    'VALIDATION_ERROR',
        errors,
      });
    }

    next();
  };
}

/* ── Pre-built validators ──────────────────────────────────── */

const loginValidator = validate([
  { field: 'username', required: true, type: 'string', min: 2,  max: 100, label: 'Username' },
  { field: 'password', required: true, type: 'string', min: 1,  max: 200, label: 'Password' },
]);

const setupValidator = validate([
  { field: 'username', required: true, type: 'string', min: 3,  max: 50,  label: 'Username' },
  {
    field: 'password', required: true, type: 'string', min: 8,  max: 128, label: 'Password',
    custom: (v) => {
      if (!/[A-Z]/.test(v) || !/[0-9]/.test(v))
        return 'Password must contain at least one uppercase letter and one number.';
      return null;
    },
  },
  { field: 'name',     required: true, type: 'string', min: 2,  max: 100, label: 'Full name' },
]);

const changePasswordValidator = validate([
  { field: 'current_password', required: true, type: 'string', min: 1,   max: 200, label: 'Current password' },
  {
    field: 'new_password', required: true, type: 'string', min: 8, max: 128, label: 'New password',
    custom: (v) => {
      if (!/[A-Z]/.test(v) || !/[0-9]/.test(v))
        return 'New password must contain at least one uppercase letter and one number.';
      return null;
    },
  },
]);

const createStudentValidator = validate([
  { field: 'full_name',     required: true,  type: 'string',   min: 2,  max: 200, label: 'Full name' },
  { field: 'email',         required: false, type: 'email',                        label: 'Email' },
  { field: 'phone',         required: false, type: 'pk_phone',                     label: 'Phone' },
  { field: 'father_phone',  required: false, type: 'pk_phone',                     label: 'Father phone' },
  { field: 'class_id',      required: false, type: 'integer',  min: 1,             label: 'Class' },
  { field: 'date_of_birth', required: false, type: 'date',                         label: 'Date of birth' },
  { field: 'gender',        required: false, pattern: /^(Male|Female|Other)$/,     label: 'Gender' },
  { field: 'cnic',          required: false, type: 'cnic',                         label: 'Student CNIC/B-Form' },
  { field: 'father_cnic',   required: false, type: 'cnic',                         label: 'Father CNIC' },
]);

const createTeacherValidator = validate([
  { field: 'full_name', required: true,  type: 'string',   min: 2, max: 200, label: 'Full name' },
  { field: 'email',     required: false, type: 'email',                       label: 'Email' },
  { field: 'phone',     required: false, type: 'pk_phone',                    label: 'Phone' },
  { field: 'cnic',      required: false, type: 'cnic',                        label: 'CNIC' },
]);

// A7: financial amount validators
const recordPaymentValidator = validate([
  { field: 'invoice_id',      required: true,  type: 'integer', min: 1,    label: 'Invoice' },
  { field: 'amount',          required: true,  type: 'number',  min: 0.01, label: 'Amount' },
  { field: 'payment_method',  required: false, type: 'string',             label: 'Payment method' },
]);

const createExpenseValidator = validate([
  { field: 'amount',          required: true,  type: 'number',  min: 0.01, label: 'Amount' },
  { field: 'description',     required: true,  type: 'string',  min: 2,    label: 'Description' },
  { field: 'expense_date',    required: true,  type: 'date',               label: 'Expense date' },
]);

const createInvoiceValidator = validate([
  { field: 'student_id',      required: true,  type: 'integer', min: 1,    label: 'Student' },
  { field: 'total_amount',    required: true,  type: 'number',  min: 0,    label: 'Total amount' },
  { field: 'due_date',        required: true,  type: 'date',               label: 'Due date' },
]);

module.exports = {
  validate,
  loginValidator,
  setupValidator,
  changePasswordValidator,
  createStudentValidator,
  createTeacherValidator,
  recordPaymentValidator,
  createExpenseValidator,
  createInvoiceValidator,
  // Exported regex for reuse in controllers/services
  PK_PHONE_RE,
  CNIC_RE,
};
