const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
require('dotenv').config();

const { verifyToken } = require('./middleware/authMiddleware');

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

const app = express();

// Security headers — CSP disabled so Vite/React dev server works
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS — handle preflight OPTIONS explicitly (required on Vercel serverless)
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
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // pre-flight for all routes

// Body parsers — 10 MB limit supports large backup file uploads
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/api/', apiLimiter);

// Public routes (no JWT required)
app.get('/api/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRoutes);

// Global JWT guard — every route below this requires a valid Bearer token
app.use(verifyToken);

// Protected routes
app.use('/api/students',      studentRoutes);
app.use('/api/classes',       classRoutes);
app.use('/api/teachers',      teacherRoutes);
app.use('/api/timetable',     timetableRoutes);
app.use('/api/attendance',    attendanceRoutes);
app.use('/api/fees',          feeRoutes);
app.use('/api/subjects',      subjectRoutes);
app.use('/api/exams',         examRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/expenses',      expenseRoutes);
app.use('/api/transport',     transportRoutes);
app.use('/api/library',       libraryRoutes);
app.use('/api/salary',        salaryRoutes);
app.use('/api/homework',      homeworkRoutes);
app.use('/api/events',        eventsRoutes);
app.use('/api/inventory',     inventoryRoutes);
app.use('/api/settings',      settingsRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/backup',        backupRoutes);
app.use('/api/messages',      messagesRoutes);
app.use('/api/diary',         diaryRoutes);
app.use('/api/board-exams',   boardExamRoutes);
app.use('/api/income',        incomeRoutes);
app.use('/api/search',        searchRoutes);
app.use('/api/leaves',        leaveRoutes);

// Error handlers
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running at http://localhost:${PORT}`));
