// ── Crash trap (must be first — catches any startup error on Vercel) ──────────
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
});

// ── Startup validation (crashes early if env vars are missing) ────────────────
require('dotenv').config();
const validateEnv = require('./utils/validateEnv');
validateEnv();

const http       = require('http');
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const compression = require('compression');
const { Server: SocketServer } = require('socket.io');
const { setupSocketIO, shutdownSocket } = require('./services/socketService');
const morgan      = require('morgan');

// ── Structured logging (Pino) ─────────────────────────────────────────────────
const logger = require('./utils/logger');
const { requestLogger } = require('./utils/logger');

// ── Swagger docs ──────────────────────────────────────────────────────────────
const swaggerUi = require('swagger-ui-express');
const { swaggerSpec, swaggerUiOptions } = require('./config/swagger');

const { verifyToken, requireRole, requirePasswordChanged } = require('./middleware/authMiddleware');
const errorHandler                   = require('./middleware/errorHandler');
const { getAuditLogs }               = require('./middleware/auditLog');
const requestId                      = require('./middleware/requestId');
const { startScheduler } = require('./utils/scheduler');
// pg-boss v12 is ESM-only — skip job queue on Vercel serverless (background jobs unsupported)
const { getQueue, work, stop: stopQueue } = process.env.VERCEL
  ? { getQueue: async () => {}, work: async () => {}, stop: async () => {} }
  : require('./jobs/queue');
const { processStudentImport } = process.env.VERCEL ? {} : require('./jobs/processors/csvImportProcessor');
const { processBulkEmail }     = process.env.VERCEL ? {} : require('./jobs/processors/emailProcessor');
const jobRoutes = process.env.VERCEL ? require('express').Router() : require('./routes/jobRoutes');

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
const lateArrivalRoutes       = require('./routes/lateArrivalRoutes');
const homeworkSubmissionRoutes = require('./routes/homeworkSubmissionRoutes');
const medicalRoutes           = require('./routes/medicalRoutes');
const canteenRoutes           = require('./routes/canteenRoutes');
const meetingRoutes           = require('./routes/meetingRoutes');
const scholarshipRoutes       = require('./routes/scholarshipRoutes');
const alumniRoutes            = require('./routes/alumniRoutes');
const rolloverRoutes          = require('./routes/rolloverRoutes');
const quizRoutes              = require('./routes/quizRoutes');
const pushRoutes              = require('./routes/pushRoutes');
const paperRoutes             = require('./routes/paperRoutes');
const onlineClassRoutes       = require('./routes/onlineClassRoutes');
const staffRoutes             = require('./routes/staffRoutes');
const automationRoutes        = require('./routes/automationRoutes');
const studyPlannerRoutes      = require('./routes/studyPlannerRoutes');
const parentFeedRoutes        = require('./routes/parentFeedRoutes');
const schoolRoutes            = require('./routes/schoolRoutes');
const whatsappRoutes          = require('./routes/whatsappRoutes');
const riskRoutes              = require('./routes/riskRoutes');
const auditRoutes             = require('./routes/auditRoutes');
const billingRoutes           = require('./routes/billingRoutes');
const onboardingRoutes        = require('./routes/onboardingRoutes');
const healthRoutes            = require('./routes/healthRoutes');
const documentRoutes          = require('./routes/documentRoutes');
const timetableGeneratorRoutes = require('./routes/timetableGeneratorRoutes');
const installmentRoutes        = require('./routes/installmentRoutes');
const disciplineRoutes         = require('./routes/disciplineRoutes');
const substitutionRoutes       = require('./routes/substitutionRoutes');
const complaintRoutes          = require('./routes/complaintRoutes');
const examSeatingRoutes        = require('./routes/examSeatingRoutes');
const hostelRoutes             = require('./routes/hostelRoutes');
const branchRoutes             = require('./routes/branchRoutes');
const budgetRoutes             = require('./routes/budgetRoutes');
const websiteRoutes            = require('./routes/websiteRoutes');
const trackingRoutes           = require('./routes/trackingRoutes');
const chatRoutes               = require('./routes/chatRoutes');
const chatbotRoutes            = require('./routes/chatbotRoutes');
const rbacRoutes               = require('./routes/rbacRoutes');
const lifecycleRoutes          = require('./routes/lifecycleRoutes');
const { metricsMiddleware }   = require('./services/metricsService');

const app = express();

// ── Create HTTP server (needed for Socket.IO) ─────────────────────────────────
// NOTE: We export this server, not just app, so Socket.IO can attach.
const httpServer = http.createServer(app);

// Trust Vercel / reverse-proxy headers so express-rate-limit can read real IPs
app.set('trust proxy', 1);

// ── 1. Request ID + metrics ───────────────────────────────────────────────────
app.use(requestId);
app.use(metricsMiddleware);

// ── 2. Response compression — gzip all JSON/text responses ───────────────────
app.use(compression());

// ── 3. HTTP request logger — Pino structured + Morgan fallback ───────────────
// Pino requestLogger for structured JSON in production; skip health-check pings
app.use((req, res, next) => {
  if (req.path === '/api/health' || req.path === '/api/health/live') return next();
  return requestLogger(req, res, next);
});
// Keep Morgan for development console readability (only in dev)
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev', { skip: (req) => req.path === '/api/health' }));
}

// ── 4. Security headers ───────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ── 5. CORS ───────────────────────────────────────────────────────────────────
const corsOptions = {
  origin: [
    'http://localhost:5173',
    'http://localhost:8081',
    'http://localhost:8082',
    'http://localhost:19006',
    'https://studentmanagement-frontend-six.vercel.app',
    'https://frontend-liart-five-45.vercel.app',
    /^http:\/\/192\.168\./,
    /^http:\/\/10\./,
    /^exp:\/\//,
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  exposedHeaders: ['Content-Disposition'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── 5b. Socket.IO — attach to HTTP server with same CORS config ───────────────
const io = new SocketServer(httpServer, {
  cors: {
    origin: corsOptions.origin,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Tune for poor Pakistan mobile internet:
  pingTimeout: 30_000,          // 30 s before declaring disconnected
  pingInterval: 15_000,         // ping every 15 s
  transports: ['websocket', 'polling'],  // polling fallback if WS blocked
  maxHttpBufferSize: 1e5,       // 100 KB max message (location payloads are tiny)
});

// Make io accessible anywhere: req.app.get('io') or req.io (injected per-router)
app.set('io', io);
setupSocketIO(io);

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

// Per-user rate limit for all authenticated routes (reads + writes)
// Raised to 300/min to comfortably cover legitimate dashboard usage
// (7 parallel API calls on load × multiple pages open = ~50 req/min normally)
const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.id ? `user_${req.user.id}` : ipKeyGenerator(req)),
  // No skip — GET requests are now throttled too
});

// Heavy read limiter — for computationally expensive GET endpoints:
// dashboard stats, analytics reports, fee summaries.
// These each run 10-15 parallel DB queries; 20/min is generous for human use.
const heavyReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many report requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.id ? `heavy_${req.user.id}` : ipKeyGenerator(req)),
  skip: (req) => req.method !== 'GET', // only applies to GET
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

// ── 8a. Swagger API docs (admin-only in production) ───────────────────────────
// Available at /api/docs and /api/v1/docs
// In production, protect behind verifyToken + requireRole — but serve spec publicly for tools
app.get('/api/docs/spec.json', (_req, res) => res.json(swaggerSpec));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));
app.use('/api/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, swaggerUiOptions));

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

// Kubernetes-style liveness (instant 200) and readiness (DB ping) probes
app.get('/api/health/live',  (_req, res) => res.json({ status: 'ok' }));
app.get('/api/health/ready', async (_req, res) => {
  try {
    const pool = require('./db');
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

// ── 9. Public routes (no JWT required) ───────────────────────────────────────
// Both /api/ and /api/v1/ are supported — /api/ is the legacy alias
for (const prefix of ['/api', '/api/v1']) {
  app.use(`${prefix}/auth/login`, loginLimiter);
  app.use(`${prefix}/auth`, authRoutes);
  // School resolve is public — login page calls it before JWT exists
  app.use(`${prefix}/schools/resolve`, schoolRoutes);
}

// ── 10. Global JWT guard ──────────────────────────────────────────────────────
app.use(verifyToken);
app.use(requirePasswordChanged);

// Per-user throttle on all authenticated routes
app.use(userLimiter);

// Heavy read limiter — dashboard stats, analytics, fee summaries
app.use([
  /^\/api(\/v1)?\/dashboard/,
  /^\/api(\/v1)?\/analytics/,
  /^\/api(\/v1)?\/fees\/dashboard-stats/,
  /^\/api(\/v1)?\/attendance\/monthly/,
  /^\/api(\/v1)?\/attendance\/summary/,
  /^\/api(\/v1)?\/salary\/summary/,
], heavyReadLimiter);

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
  ['/late-arrivals',        lateArrivalRoutes],
  ['/homework-submissions', homeworkSubmissionRoutes],
  ['/medical',              medicalRoutes],
  ['/canteen',              canteenRoutes],
  ['/meetings',             meetingRoutes],
  ['/scholarships',         scholarshipRoutes],
  ['/alumni',               alumniRoutes],
  ['/rollover',             rolloverRoutes],
  ['/quizzes',              quizRoutes],
  ['/jobs',                 jobRoutes],
  ['/push',                 pushRoutes],
  ['/papers',               paperRoutes],
  ['/online-classes',       onlineClassRoutes],
  ['/staff',                staffRoutes],
  ['/automation',           automationRoutes],
  ['/study-planner',        studyPlannerRoutes],
  ['/parent-feed',          parentFeedRoutes],
  ['/schools',              schoolRoutes],
  ['/whatsapp',             whatsappRoutes],
  ['/risk',                 riskRoutes],
  ['/audit',                auditRoutes],
  ['/billing',              billingRoutes],
  ['/onboarding',           onboardingRoutes],
  ['/system-health',        healthRoutes],
  ['/documents',            documentRoutes],
  ['/timetable-generator',  timetableGeneratorRoutes],
  ['/installments',         installmentRoutes],
  ['/discipline',           disciplineRoutes],
  ['/substitutions',        substitutionRoutes],
  ['/complaints',           complaintRoutes],
  ['/exam-seating',         examSeatingRoutes],
  ['/hostel',               hostelRoutes],
  ['/branches',             branchRoutes],
  ['/budget',               budgetRoutes],
  ['/website',              websiteRoutes],
  ['/tracking',             trackingRoutes],
  ['/chat',                 chatRoutes],
  ['/chatbot',              chatbotRoutes],
  ['/rbac',                 rbacRoutes],
  ['/lifecycle',            lifecycleRoutes],
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

// ── 13. Start server + background scheduler + job queue ───────────────────────
// Skip listen() on Vercel — it uses module.exports = app as the serverless handler.
// Vercel automatically sets process.env.VERCEL = '1' in all serverless deployments.
const PORT = process.env.PORT || 5000;
if (!process.env.VERCEL) {
  // Use httpServer (not app.listen) so Socket.IO shares the same port
  const server = httpServer.listen(PORT, '0.0.0.0', async () => {
    logger.info({ port: PORT }, `🚀  Server running at http://localhost:${PORT}`);
    startScheduler();

    try {
      await getQueue();
      await work('csv-import-students', processStudentImport);
      await work('bulk-email', processBulkEmail);
    } catch (err) {
      logger.warn({ err: err.message }, '[queue] Failed to start job queue — continuing without it');
    }
  });

  // ── 14. Graceful shutdown ─────────────────────────────────────────────────
  const shutdown = (signal) => {
    logger.info({ signal }, 'Graceful shutdown initiated…');
    server.close(async () => {
      logger.info('HTTP server closed.');
      try { await stopQueue(); } catch { /* best effort */ }
      shutdownSocket();
      try {
        const pool = require('./db');
        await pool.end();
        logger.info('DB pool closed.');
      } catch (err) {
        logger.error({ err: err.message }, 'Error closing DB pool');
      }
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced exit after 10 s timeout.');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

// Catch unhandled promise rejections — log and continue (don't crash)
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

// ── 15. Export for Vercel serverless ─────────────────────────────────────────
// Note: Vercel serverless does NOT support Socket.IO persistent connections.
// For real-time tracking in production, deploy on a persistent server (Railway, DigitalOcean, VPS).
module.exports = app;
