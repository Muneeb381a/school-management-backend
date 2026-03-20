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
const PHONE_RE = /^[+\d\s\-().]{7,20}$/;

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
  { field: 'full_name',     required: true,  type: 'string',  min: 2,  max: 200,  label: 'Full name' },
  { field: 'email',         required: false, type: 'email',                        label: 'Email' },
  { field: 'phone',         required: false, type: 'phone',                        label: 'Phone' },
  { field: 'class_id',      required: false, type: 'integer', min: 1,              label: 'Class' },
  { field: 'date_of_birth', required: false, type: 'date',                         label: 'Date of birth' },
  { field: 'gender',        required: false, pattern: /^(Male|Female|Other)$/,     label: 'Gender' },
]);

const createTeacherValidator = validate([
  { field: 'full_name', required: true,  type: 'string', min: 2,  max: 200, label: 'Full name' },
  { field: 'email',     required: false, type: 'email',                      label: 'Email' },
  { field: 'phone',     required: false, type: 'phone',                      label: 'Phone' },
]);

module.exports = {
  validate,
  loginValidator,
  setupValidator,
  changePasswordValidator,
  createStudentValidator,
  createTeacherValidator,
};
