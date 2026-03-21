// ── Startup validation (crashes early if env vars are missing) ────────────────
require('dotenv').config();
const validateEnv = require('./utils/validateEnv');
validateEnv();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const compression = require('compression');
const morgan      = require('morgan');

const { verifyToken, requireRole }   = require('./middleware/authMiddleware');
const errorHandler                   = require('./middleware/errorHandler');
const { getAuditLogs }               = require('./middleware/auditLog');
const requestId                      = require('./middleware/requestId');
const { startScheduler }             = require('./utils/scheduler');

const studentRoutes      = require('./routes/studentRoutes');
const classRoutes        = require('./routes/classRoutes');
const teacherRoutes      = require('./routes/teacherRoutes');
const timetableRoutes    = require('./routes/timetableRoutes');
const attendanceRoutes   = require('./routes/attendanceRoutes');
const feeRoutes          = require('./routes/feeRoutes');
const subjectRoutes      = require('./routes/subjectRoutes');
const examRoutes         = require('./routes/examRoutes');
const announcementRoutes = require('./routes/announcementRoutes');
const expenseRoutes      = require('./routes/expenseRoutes');
const transportRoutes    = require('./routes/transportRoutes');
const libraryRoutes      = require('./routes/libraryRoutes');
const salaryRoutes       = require('./routes/salaryRoutes');
const homeworkRoutes     = require('./routes/homeworkRoutes');
const eventsRoutes       = require('./routes/eventsRoutes');
const inventoryRoutes    = require('./routes/inventoryRoutes');
const settingsRoutes     = require('./routes/settingsRoutes');
const dashboardRoutes    = require('./routes/dashboardRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const authRoutes         = require('./routes/authRoutes');
const backupRoutes       = require('./routes/backupRoutes');
const messagesRoutes     = require('./routes/messagesRoutes');
const diaryRoutes        = require('./routes/diaryRoutes');
const boardExamRoutes    = require('./routes/boardExamRoutes');
const incomeRoutes       = require('./routes/incomeRoutes');
const searchRoutes       = require('./routes/searchRoutes');
const leaveRoutes        = require('./routes/leaveRoutes');
const syllabusRoutes     = require('./routes/syllabusRoutes');
const analyticsRoutes    = require('./routes/analyticsRoutes');

const app = express();

// Trust Vercel / reverse-proxy headers so express-rate-limit can read real IPs
app.set('trust proxy', 1);

// ── 1. Request ID — attach before anything logs ───────────────────────────────
app.use(requestId);

// ── 2. Response compression — gzip all JSON/text responses ───────────────────
app.use(compression());

// ── 3. HTTP logger — skip health-check noise in production ───────────────────
const morganFormat = process.env.NODE_ENV === 'production' ? 'combined' : 'dev';
app.use(morgan(morganFormat, {
  skip: (req) => req.path === '/api/health',
}));

// ── 4. Security headers ───────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ── 5. CORS ───────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'http://localhost:8081',
    'http://localhost:19006',
    'https://studentmanagement-frontend-six.vercel.app',
    /^http:\/\/192\.168\./,
    /^http:\/\/10\./,
    /^exp:\/\//,
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── 6. Body parsers ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── 7. Rate limiters ──────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
});

// Per-user rate limit for authenticated routes (100 req/min per user)
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Key: authenticated user ID (set by verifyToken) or normalized IP as fallback
  keyGenerator: (req) => (req.user?.id ? `user_${req.user.id}` : ipKeyGenerator(req)),
  skip: (req) => req.method === 'GET', // reads are cheaper — don't throttle GETs
});

// Global API limiter (fallback for unauthenticated routes)
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
});

// Export rate limiter — 3 CSV/Excel exports per hour per authenticated user
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, message: 'Export limit reached. You can export up to 3 times per hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.id ? `export_user_${req.user.id}` : ipKeyGenerator(req)),
});

app.use('/api/', apiLimiter);
app.use('/api/v1/', apiLimiter);

// ── 8. Health check v2 ────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  const pool = require('./db');
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    const dbLatencyMs = Date.now() - start;
    res.json({
      status:      'ok',
      db:          'connected',
      dbLatencyMs,
      uptime:      Math.floor(process.uptime()),
      memoryMB:    Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      timestamp:   new Date().toISOString(),
      version:     process.env.npm_package_version || '1.0.0',
    });
  } catch (err) {
    res.status(503).json({
      status:    'degraded',
      db:        'error',
      error:     err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ── 9. Public routes (no JWT required) ───────────────────────────────────────
// Both /api/ and /api/v1/ are supported — /api/ is the legacy alias
for (const prefix of ['/api', '/api/v1']) {
  app.use(`${prefix}/auth/login`, loginLimiter);
  app.use(`${prefix}/auth`, authRoutes);
}

// ── 10. Global JWT guard ──────────────────────────────────────────────────────
app.use(verifyToken);

// Per-user throttle on all authenticated write operations
app.use(userLimiter);

// Export rate limiter — applied before any /export or /import route
app.use([
  /^\/api(\/v1)?\/students\/export/,
  /^\/api(\/v1)?\/teachers\/export/,
  /^\/api(\/v1)?\/fees\/export/,
  /^\/api(\/v1)?\/attendance\/export/,
  /^\/api(\/v1)?\/expenses\/export/,
  /^\/api(\/v1)?\/salary\/export/,
], exportLimiter);

// ── 11. Protected routes — mounted on both /api and /api/v1 ──────────────────
const routeMap = [
  ['/students',      studentRoutes],
  ['/classes',       classRoutes],
  ['/teachers',      teacherRoutes],
  ['/timetable',     timetableRoutes],
  ['/attendance',    attendanceRoutes],
  ['/fees',          feeRoutes],
  ['/subjects',      subjectRoutes],
  ['/exams',         examRoutes],
  ['/announcements', announcementRoutes],
  ['/expenses',      expenseRoutes],
  ['/transport',     transportRoutes],
  ['/library',       libraryRoutes],
  ['/salary',        salaryRoutes],
  ['/homework',      homeworkRoutes],
  ['/events',        eventsRoutes],
  ['/inventory',     inventoryRoutes],
  ['/settings',      settingsRoutes],
  ['/dashboard',     dashboardRoutes],
  ['/notifications', notificationRoutes],
  ['/backup',        backupRoutes],
  ['/messages',      messagesRoutes],
  ['/diary',         diaryRoutes],
  ['/board-exams',   boardExamRoutes],
  ['/income',        incomeRoutes],
  ['/search',        searchRoutes],
  ['/leaves',        leaveRoutes],
  ['/syllabus',      syllabusRoutes],
  ['/analytics',     analyticsRoutes],
];

for (const [path, router] of routeMap) {
  app.use(`/api${path}`,    router);
  app.use(`/api/v1${path}`, router);
}

// Admin-only audit log viewer
app.get('/api/audit-logs',    requireRole('admin'), getAuditLogs);
app.get('/api/v1/audit-logs', requireRole('admin'), getAuditLogs);

// ── 12. 404 + centralized error handler ──────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found.' }));
app.use(errorHandler);

// ── 13. Start server + background scheduler ───────────────────────────────────
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀  Server running at http://localhost:${PORT}`);
  startScheduler();
});

// ── 14. Graceful shutdown ─────────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`\n[${signal}] Graceful shutdown initiated…`);
  server.close(async () => {
    console.log('HTTP server closed.');
    try {
      const pool = require('./db');
      await pool.end();
      console.log('DB pool closed.');
    } catch (err) {
      console.error('Error closing DB pool:', err.message);
    }
    process.exit(0);
  });

  // Force exit if it takes too long
  setTimeout(() => {
    console.error('Forced exit after 10 s timeout.');
    process.exit(1);
  }, 10_000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Catch unhandled promise rejections — log and continue (don't crash)
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
