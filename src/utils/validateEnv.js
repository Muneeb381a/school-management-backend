/**
 * Startup environment validator.
 * Call this ONCE at the very top of index.js (before any route is registered).
 * The process crashes immediately with a clear message if anything required is absent.
 */

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
];

const OPTIONAL_DEFAULTS = {
  PORT: '5000',
  NODE_ENV: 'development',
};

function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);

  if (missing.length) {
    console.error('\n❌  FATAL: Missing required environment variables:\n');
    missing.forEach((k) => console.error(`   • ${k}`));
    console.error('\nSet them in your .env file (local) or deployment dashboard (production).\n');
    process.exit(1);
  }

  // Apply defaults for optional vars
  for (const [key, value] of Object.entries(OPTIONAL_DEFAULTS)) {
    if (!process.env[key]) process.env[key] = value;
  }

  // Warn about obviously-weak secrets in production
  if (process.env.NODE_ENV === 'production') {
    const weakSecrets = [
      ['JWT_SECRET',         'change_this'],
      ['JWT_REFRESH_SECRET', 'change_this'],
    ];
    weakSecrets.forEach(([key, marker]) => {
      if (process.env[key]?.includes(marker)) {
        console.warn(`\n⚠️   WARNING: ${key} looks like a placeholder value. Rotate it before going live.\n`);
      }
    });
  }

  console.log('✅  Environment validated.');
}

module.exports = validateEnv;
