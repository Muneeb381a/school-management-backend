'use strict';

const swaggerJsdoc = require('swagger-jsdoc');

// ─────────────────────────────────────────────────────────────────────────────
// REUSABLE SCHEMA COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
const components = {
  securitySchemes: {
    BearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Paste your JWT access token (obtained from POST /api/auth/login).',
    },
  },
  schemas: {
    // ── Domain models ──────────────────────────────────────────────────────
    Student: {
      type: 'object',
      properties: {
        id:              { type: 'integer',  example: 1 },
        full_name:       { type: 'string',   example: 'Ali Hassan' },
        admission_no:    { type: 'string',   example: 'ADM-2024-001' },
        grade:           { type: 'string',   example: '5' },
        section:         { type: 'string',   example: 'A' },
        class_id:        { type: 'integer',  example: 3 },
        gender:          { type: 'string',   enum: ['male', 'female'], example: 'male' },
        date_of_birth:   { type: 'string',   format: 'date', example: '2012-04-10' },
        father_name:     { type: 'string',   example: 'Hassan Khan' },
        father_phone:    { type: 'string',   example: '+923001234567' },
        father_cnic:     { type: 'string',   example: '35202-1234567-1' },
        mother_name:     { type: 'string',   example: 'Fatima Khan' },
        address:         { type: 'string',   example: 'House 12, Street 4, Lahore' },
        status: {
          type: 'string',
          enum: ['active', 'inactive', 'suspended', 'graduated', 'transferred'],
          example: 'active',
        },
        photo_url:       { type: 'string',   nullable: true, example: 'https://cdn.example.com/photo.jpg' },
        created_at:      { type: 'string',   format: 'date-time' },
        deleted_at:      { type: 'string',   format: 'date-time', nullable: true },
      },
    },

    Teacher: {
      type: 'object',
      properties: {
        id:          { type: 'integer', example: 1 },
        full_name:   { type: 'string',  example: 'Sarah Ahmed' },
        phone:       { type: 'string',  example: '+923009876543' },
        email:       { type: 'string',  format: 'email', example: 'sarah@school.edu' },
        cnic:        { type: 'string',  example: '35202-9876543-2' },
        designation: { type: 'string',  example: 'Senior Teacher' },
        status: {
          type: 'string',
          enum: ['active', 'inactive', 'on_leave'],
          example: 'active',
        },
        join_date:   { type: 'string',  format: 'date', example: '2022-08-15' },
        photo_url:   { type: 'string',  nullable: true },
        created_at:  { type: 'string',  format: 'date-time' },
      },
    },

    Class: {
      type: 'object',
      properties: {
        id:           { type: 'integer', example: 3 },
        name:         { type: 'string',  example: 'Grade 5 - A' },
        grade:        { type: 'string',  example: '5' },
        section:      { type: 'string',  example: 'A' },
        capacity:     { type: 'integer', example: 35 },
        class_teacher_id: { type: 'integer', nullable: true, example: 2 },
        student_count: { type: 'integer', example: 32 },
        created_at:   { type: 'string',  format: 'date-time' },
      },
    },

    FeeInvoice: {
      type: 'object',
      properties: {
        id:              { type: 'integer', example: 100 },
        student_id:      { type: 'integer', example: 1 },
        student_name:    { type: 'string',  example: 'Ali Hassan' },
        class_id:        { type: 'integer', example: 3 },
        total_amount:    { type: 'number',  format: 'float', example: 5000.00 },
        fine_amount:     { type: 'number',  format: 'float', example: 0.00 },
        discount_amount: { type: 'number',  format: 'float', example: 500.00 },
        paid_amount:     { type: 'number',  format: 'float', example: 0.00 },
        due_date:        { type: 'string',  format: 'date',  example: '2024-07-31' },
        issue_date:      { type: 'string',  format: 'date',  example: '2024-07-01' },
        status: {
          type: 'string',
          enum: ['unpaid', 'paid', 'partial', 'overdue', 'cancelled', 'waived'],
          example: 'unpaid',
        },
        month:           { type: 'string',  example: '2024-07' },
        remarks:         { type: 'string',  nullable: true },
        created_at:      { type: 'string',  format: 'date-time' },
      },
    },

    FeePayment: {
      type: 'object',
      properties: {
        id:              { type: 'integer', example: 55 },
        invoice_id:      { type: 'integer', example: 100 },
        student_id:      { type: 'integer', example: 1 },
        amount:          { type: 'number',  format: 'float', example: 4500.00 },
        payment_date:    { type: 'string',  format: 'date',  example: '2024-07-15' },
        payment_method:  { type: 'string',  enum: ['cash', 'bank_transfer', 'cheque', 'online'], example: 'cash' },
        transaction_ref: { type: 'string',  nullable: true, example: 'TXN-20240715-001' },
        receipt_no:      { type: 'string',  example: 'RCP-2024-055' },
        received_by:     { type: 'integer', example: 1 },
        created_at:      { type: 'string',  format: 'date-time' },
      },
    },

    Attendance: {
      type: 'object',
      properties: {
        id:          { type: 'integer', example: 200 },
        student_id:  { type: 'integer', example: 1 },
        class_id:    { type: 'integer', example: 3 },
        date:        { type: 'string',  format: 'date', example: '2024-07-15' },
        status: {
          type: 'string',
          enum: ['present', 'absent', 'late', 'excused', 'leave'],
          example: 'present',
        },
        remarks:     { type: 'string',  nullable: true, example: 'Arrived 10 mins late' },
        recorded_by: { type: 'integer', example: 3, description: 'Teacher user id' },
        created_at:  { type: 'string',  format: 'date-time' },
      },
    },

    Announcement: {
      type: 'object',
      properties: {
        id:         { type: 'integer', example: 10 },
        title:      { type: 'string',  example: 'School Closed – National Holiday' },
        body:       { type: 'string',  example: 'School will be closed on 14th August.' },
        target_role: { type: 'string', enum: ['all', 'student', 'teacher', 'parent'], example: 'all' },
        class_id:   { type: 'integer', nullable: true, example: null },
        is_pinned:  { type: 'boolean', example: false },
        created_by: { type: 'integer', example: 1 },
        created_at: { type: 'string',  format: 'date-time' },
      },
    },

    Bus: {
      type: 'object',
      properties: {
        id:           { type: 'integer', example: 1 },
        bus_number:   { type: 'string',  example: 'SKL-001' },
        capacity:     { type: 'integer', example: 40 },
        driver_id:    { type: 'integer', nullable: true, example: 2 },
        driver_name:  { type: 'string',  nullable: true, example: 'Imran Ali' },
        route_id:     { type: 'integer', nullable: true, example: 1 },
        route_name:   { type: 'string',  nullable: true, example: 'Route A – Johar Town' },
        status:       { type: 'string',  enum: ['active', 'inactive', 'maintenance'], example: 'active' },
      },
    },

    ChatbotQuery: {
      type: 'object',
      required: ['query'],
      properties: {
        query:  { type: 'string', example: 'What are my pending fees?' },
      },
    },

    ChatbotResponse: {
      type: 'object',
      properties: {
        success:  { type: 'boolean', example: true },
        data: {
          type: 'object',
          properties: {
            intent:   { type: 'string', example: 'fees' },
            response: { type: 'string', example: 'You have 1 unpaid invoice of PKR 4,500 due on 31 July 2024.' },
          },
        },
      },
    },

    // ── Generic envelopes ──────────────────────────────────────────────────
    ErrorResponse: {
      type: 'object',
      required: ['success', 'message'],
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string',  example: 'Unauthorized' },
      },
    },

    SuccessResponse: {
      type: 'object',
      required: ['success', 'data'],
      properties: {
        success: { type: 'boolean', example: true },
        data:    { type: 'object' },
      },
    },

    PaginatedResponse: {
      type: 'object',
      required: ['success', 'data', 'pagination'],
      properties: {
        success: { type: 'boolean', example: true },
        data: {
          type: 'array',
          items: { type: 'object' },
        },
        pagination: {
          type: 'object',
          properties: {
            page:       { type: 'integer', example: 1 },
            limit:      { type: 'integer', example: 20 },
            total:      { type: 'integer', example: 150 },
            totalPages: { type: 'integer', example: 8 },
          },
        },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PATH DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
const paths = {

  // ════════════════════════════════════════════════════════════════════════════
  // SYSTEM
  // ════════════════════════════════════════════════════════════════════════════
  '/api/health': {
    get: {
      tags: ['System'],
      summary: 'Health check',
      description: 'Returns server status, DB connectivity, uptime, and memory usage. No authentication required.',
      operationId: 'healthCheck',
      security: [],
      responses: {
        200: {
          description: 'Server is healthy',
          content: {
            'application/json': {
              example: {
                status: 'ok', db: 'connected', dbLatencyMs: 4,
                uptime: 3600, memoryMB: 128, version: '1.0.0',
                timestamp: '2024-07-15T10:00:00.000Z',
              },
            },
          },
        },
        503: { description: 'Database unreachable' },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // AUTH
  // ════════════════════════════════════════════════════════════════════════════
  '/api/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login',
      description: `Authenticates a user and returns a short-lived JWT **accessToken** (15 min) and a long-lived **refreshToken** (7 days).

**Rate limit:** 20 requests / 15 minutes per IP.
**Account lockout:** 5 consecutive failures within 15 minutes locks the account.`,
      operationId: 'login',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['username', 'password'],
              properties: {
                username:    { type: 'string',  example: 'admin' },
                password:    { type: 'string',  format: 'password', example: 'admin123' },
                school_code: { type: 'string',  nullable: true, example: null, description: 'Required for multi-tenant setups; null for single-tenant.' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Login successful',
          content: {
            'application/json': {
              example: {
                success: true,
                data: {
                  accessToken: 'eyJhbGci...', refreshToken: 'eyJhbGci...',
                  user: { id: 1, username: 'admin', name: 'Administrator', role: 'admin' },
                },
              },
            },
          },
        },
        401: { description: 'Invalid credentials' },
        423: { description: 'Account locked — too many failed attempts' },
        429: { description: 'Rate limit exceeded' },
      },
    },
  },

  '/api/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Refresh access token',
      description: 'Exchanges a valid refresh token for a new access token. No Authorization header needed.',
      operationId: 'refreshToken',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['refreshToken'],
              properties: {
                refreshToken: { type: 'string', example: 'eyJhbGci...' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'New access token issued', content: { 'application/json': { example: { success: true, data: { accessToken: 'eyJhbGci...' } } } } },
        401: { description: 'Refresh token invalid or expired' },
      },
    },
  },

  '/api/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'Get current user profile',
      description: 'Returns the authenticated user\'s profile data.',
      operationId: 'getMe',
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: 'User profile',
          content: {
            'application/json': {
              example: {
                success: true,
                data: { id: 1, username: 'admin', name: 'Administrator', role: 'admin', entity_id: null },
              },
            },
          },
        },
        401: { description: 'Unauthorized' },
      },
    },
  },

  '/api/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Logout',
      description: 'Revokes the current session. Pass the refresh token in the body so it is blacklisted.',
      operationId: 'logout',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { refreshToken: { type: 'string' } },
            },
          },
        },
      },
      responses: {
        200: { description: 'Logged out successfully' },
        401: { description: 'Unauthorized' },
      },
    },
  },

  '/api/auth/change-password': {
    put: {
      tags: ['Auth'],
      summary: 'Change password',
      description: 'Changes the authenticated user\'s password. Requires the current password for verification.',
      operationId: 'changePassword',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['currentPassword', 'newPassword'],
              properties: {
                currentPassword: { type: 'string', format: 'password' },
                newPassword:     { type: 'string', format: 'password', minLength: 8, example: 'NewSecure@123' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Password changed successfully' },
        400: { description: 'Current password incorrect or validation failed' },
        401: { description: 'Unauthorized' },
      },
    },
  },

  '/api/auth/forgot-password': {
    post: {
      tags: ['Auth'],
      summary: 'Request password reset',
      description: 'Sends a password-reset link to the user\'s registered email. Rate-limited to 3 requests/hour.',
      operationId: 'forgotPassword',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email'],
              properties: { email: { type: 'string', format: 'email', example: 'admin@school.edu' } },
            },
          },
        },
      },
      responses: {
        200: { description: 'Reset email sent (or silently ignored if email not found)' },
        429: { description: 'Rate limit: max 3 requests per hour' },
      },
    },
  },

  '/api/auth/sessions': {
    get: {
      tags: ['Auth'],
      summary: 'List active sessions',
      description: 'Returns all active login sessions for the current user.',
      operationId: 'getSessions',
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: 'List of active sessions',
          content: {
            'application/json': {
              example: {
                success: true,
                data: [{ id: 'abc123', ip: '192.168.1.5', device: 'Chrome/Windows', created_at: '2024-07-15T08:00:00Z' }],
              },
            },
          },
        },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // STUDENTS
  // ════════════════════════════════════════════════════════════════════════════
  '/api/students': {
    get: {
      tags: ['Students'],
      summary: 'List students',
      description: 'Returns a paginated, filterable list of active students. Teachers see all students; the response excludes soft-deleted records.',
      operationId: 'listStudents',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'page',     in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit',    in: 'query', schema: { type: 'integer', default: 20, maximum: 200 } },
        { name: 'search',   in: 'query', schema: { type: 'string' }, description: 'Search by full_name or admission_no' },
        { name: 'class_id', in: 'query', schema: { type: 'integer' } },
        { name: 'grade',    in: 'query', schema: { type: 'string' }, example: '5' },
        { name: 'status',   in: 'query', schema: { type: 'string', enum: ['active', 'inactive', 'suspended', 'graduated'] } },
        { name: 'gender',   in: 'query', schema: { type: 'string', enum: ['male', 'female'] } },
      ],
      responses: {
        200: { description: 'Paginated student list', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaginatedResponse' } } } },
        401: { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
        403: { description: 'Forbidden — requires admin or teacher role' },
      },
    },
    post: {
      tags: ['Students'],
      summary: 'Create student',
      description: 'Creates a new student record and automatically generates login credentials. **Admin only.**',
      operationId: 'createStudent',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Student' },
            example: {
              full_name: 'Ali Hassan', class_id: 3, gender: 'male',
              date_of_birth: '2012-04-10', father_name: 'Hassan Khan',
              father_phone: '+923001234567', address: 'Lahore',
            },
          },
        },
      },
      responses: {
        201: { description: 'Student created', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
        400: { description: 'Validation error (missing required fields)' },
        401: { description: 'Unauthorized' },
        403: { description: 'Forbidden — admin only' },
      },
    },
  },

  '/api/students/{id}': {
    get: {
      tags: ['Students'],
      summary: 'Get student by ID',
      operationId: 'getStudent',
      security: [{ BearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: {
        200: { description: 'Student detail', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
        404: { description: 'Student not found' },
      },
    },
    put: {
      tags: ['Students'],
      summary: 'Update student',
      operationId: 'updateStudent',
      security: [{ BearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Student' } } },
      },
      responses: {
        200: { description: 'Student updated' },
        404: { description: 'Student not found' },
        403: { description: 'Admin only' },
      },
    },
    delete: {
      tags: ['Students'],
      summary: 'Soft-delete student',
      description: 'Sets `deleted_at` to the current timestamp — the student is hidden from all lists but the record is preserved.',
      operationId: 'deleteStudent',
      security: [{ BearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: {
        200: { description: 'Student deleted (soft)' },
        403: { description: 'Admin only' },
        404: { description: 'Student not found' },
      },
    },
  },

  '/api/students/export': {
    get: {
      tags: ['Students'],
      summary: 'Export students to CSV/Excel',
      description: 'Exports the full student list. Rate-limited to 3 exports per hour.',
      operationId: 'exportStudents',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'format', in: 'query', schema: { type: 'string', enum: ['csv', 'excel'], default: 'csv' } },
        { name: 'class_id', in: 'query', schema: { type: 'integer' } },
      ],
      responses: {
        200: { description: 'File download', content: { 'text/csv': {} } },
        429: { description: 'Export limit reached (3/hour)' },
      },
    },
  },

  '/api/students/import': {
    post: {
      tags: ['Students'],
      summary: 'Bulk import students from CSV',
      description: 'Imports students from a CSV file. Download the template first via GET /api/students/import/template.',
      operationId: 'importStudents',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } } },
      },
      responses: {
        200: { description: 'Import result with success/error counts', content: { 'application/json': { example: { success: true, data: { imported: 45, errors: 2, errorRows: [{ row: 3, error: 'Missing full_name' }] } } } } },
        400: { description: 'Invalid file format' },
        403: { description: 'Admin only' },
      },
    },
  },

  '/api/students/{id}/reset-credentials': {
    post: {
      tags: ['Students'],
      summary: 'Reset student login credentials',
      description: 'Generates a new username and password for the student portal. **Admin only.**',
      operationId: 'resetStudentCredentials',
      security: [{ BearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: {
        200: { description: 'New credentials returned', content: { 'application/json': { example: { success: true, data: { username: 'ali.hassan', password: 'Temp@1234' } } } } },
        403: { description: 'Admin only' },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TEACHERS
  // ════════════════════════════════════════════════════════════════════════════
  '/api/teachers': {
    get: {
      tags: ['Teachers'],
      summary: 'List teachers',
      operationId: 'listTeachers',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'page',   in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit',  in: 'query', schema: { type: 'integer', default: 20 } },
        { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Search by name or email' },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'inactive', 'on_leave'] } },
      ],
      responses: {
        200: { description: 'Paginated teacher list', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaginatedResponse' } } } },
        401: { description: 'Unauthorized' },
      },
    },
    post: {
      tags: ['Teachers'],
      summary: 'Create teacher',
      description: 'Creates a new teacher and auto-generates login credentials. **Admin only.**',
      operationId: 'createTeacher',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Teacher' },
            example: { full_name: 'Sarah Ahmed', phone: '+923009876543', email: 'sarah@school.edu', designation: 'Senior Teacher' },
          },
        },
      },
      responses: {
        201: { description: 'Teacher created' },
        403: { description: 'Admin only' },
      },
    },
  },

  '/api/teachers/{id}': {
    get: {
      tags: ['Teachers'],
      summary: 'Get teacher by ID',
      operationId: 'getTeacher',
      security: [{ BearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: {
        200: { description: 'Teacher detail with assigned classes and subjects' },
        404: { description: 'Teacher not found' },
      },
    },
    put: {
      tags: ['Teachers'],
      summary: 'Update teacher',
      operationId: 'updateTeacher',
      security: [{ BearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Teacher' } } } },
      responses: { 200: { description: 'Teacher updated' }, 403: { description: 'Admin only' } },
    },
    delete: {
      tags: ['Teachers'],
      summary: 'Soft-delete teacher',
      operationId: 'deleteTeacher',
      security: [{ BearerAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: { 200: { description: 'Teacher deleted (soft)' }, 403: { description: 'Admin only' } },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CLASSES
  // ════════════════════════════════════════════════════════════════════════════
  '/api/classes': {
    get: {
      tags: ['Classes'],
      summary: 'List all classes',
      operationId: 'listClasses',
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: 'List of all classes with student count',
          content: { 'application/json': { example: { success: true, data: [{ id: 1, name: 'Grade 1 - A', grade: '1', section: 'A', student_count: 30 }] } } },
        },
      },
    },
    post: {
      tags: ['Classes'],
      summary: 'Create class',
      operationId: 'createClass',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Class' },
            example: { name: 'Grade 5 - A', grade: '5', section: 'A', capacity: 35 },
          },
        },
      },
      responses: { 201: { description: 'Class created' }, 403: { description: 'Admin only' } },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ATTENDANCE
  // ════════════════════════════════════════════════════════════════════════════
  '/api/attendance': {
    post: {
      tags: ['Attendance'],
      summary: 'Submit attendance',
      description: 'Saves the attendance for an entire class for a given date. Existing records for that date are overwritten.',
      operationId: 'submitAttendance',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: {
              class_id: 3,
              date: '2024-07-15',
              attendance: [
                { student_id: 1, status: 'present' },
                { student_id: 2, status: 'absent', remarks: 'Sick' },
                { student_id: 3, status: 'late' },
              ],
            },
          },
        },
      },
      responses: {
        200: { description: 'Attendance saved', content: { 'application/json': { example: { success: true, data: { saved: 30 } } } } },
        400: { description: 'Validation error' },
        403: { description: 'Admin or teacher only' },
      },
    },
  },

  '/api/attendance/class/{classId}': {
    get: {
      tags: ['Attendance'],
      summary: 'Get attendance for a class on a date',
      operationId: 'getClassAttendance',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'classId', in: 'path',  required: true, schema: { type: 'integer' } },
        { name: 'date',    in: 'query', required: true, schema: { type: 'string', format: 'date' }, example: '2024-07-15' },
      ],
      responses: {
        200: {
          description: 'Attendance records for the class',
          content: {
            'application/json': {
              example: {
                success: true,
                data: [
                  { student_id: 1, full_name: 'Ali Hassan', status: 'present' },
                  { student_id: 2, full_name: 'Sara Malik', status: 'absent' },
                ],
              },
            },
          },
        },
      },
    },
  },

  '/api/attendance/monthly': {
    get: {
      tags: ['Attendance'],
      summary: 'Monthly attendance summary',
      description: 'Returns per-student attendance percentage for a class over a month.',
      operationId: 'getMonthlyAttendance',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'class_id', in: 'query', required: true,  schema: { type: 'integer' } },
        { name: 'month',    in: 'query', required: true,  schema: { type: 'string' }, example: '2024-07', description: 'Format: YYYY-MM' },
      ],
      responses: {
        200: {
          description: 'Monthly summary per student',
          content: {
            'application/json': {
              example: {
                success: true,
                data: [{ student_id: 1, full_name: 'Ali Hassan', present: 20, absent: 2, late: 1, percentage: 90.9 }],
              },
            },
          },
        },
      },
    },
  },

  '/api/attendance/export': {
    get: {
      tags: ['Attendance'],
      summary: 'Export attendance to CSV',
      description: 'Exports attendance data as CSV. Rate-limited to 3 exports/hour.',
      operationId: 'exportAttendance',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'class_id', in: 'query', required: true, schema: { type: 'integer' } },
        { name: 'month',    in: 'query', required: true, schema: { type: 'string' }, example: '2024-07' },
      ],
      responses: {
        200: { description: 'CSV file download', content: { 'text/csv': {} } },
        429: { description: 'Export rate limit reached' },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // FEES
  // ════════════════════════════════════════════════════════════════════════════
  '/api/fees/dashboard-stats': {
    get: {
      tags: ['Fees'],
      summary: 'Fee dashboard statistics',
      description: 'Returns total collected, outstanding, and defaulter count for the current month.',
      operationId: 'getFeeDashboard',
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: 'Fee KPIs',
          content: {
            'application/json': {
              example: {
                success: true,
                data: {
                  collectedThisMonth: 850000,
                  outstanding: 125000,
                  defaulterCount: 12,
                  collectionRate: 87.2,
                },
              },
            },
          },
        },
      },
    },
  },

  '/api/fees/invoices': {
    get: {
      tags: ['Fees'],
      summary: 'List fee invoices',
      operationId: 'listInvoices',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'page',       in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit',      in: 'query', schema: { type: 'integer', default: 20 } },
        { name: 'student_id', in: 'query', schema: { type: 'integer' } },
        { name: 'class_id',   in: 'query', schema: { type: 'integer' } },
        { name: 'status',     in: 'query', schema: { type: 'string', enum: ['unpaid', 'paid', 'partial', 'overdue', 'cancelled', 'waived'] } },
        { name: 'month',      in: 'query', schema: { type: 'string' }, example: '2024-07' },
      ],
      responses: {
        200: { description: 'Paginated invoices', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaginatedResponse' } } } },
      },
    },
    post: {
      tags: ['Fees'],
      summary: 'Create manual invoice',
      description: 'Creates a single invoice manually. For monthly bulk generation, use POST /api/fees/invoices/generate-monthly.',
      operationId: 'createInvoice',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: {
              student_id: 1, class_id: 3, month: '2024-07',
              due_date: '2024-07-31', items: [{ fee_head_id: 1, amount: 3000 }, { fee_head_id: 2, amount: 500 }],
            },
          },
        },
      },
      responses: {
        201: { description: 'Invoice created' },
        403: { description: 'Admin only' },
      },
    },
  },

  '/api/fees/invoices/generate-monthly': {
    post: {
      tags: ['Fees'],
      summary: 'Generate monthly fee invoices',
      description: 'Bulk-generates invoices for all active students based on their fee structures. Skips students who already have an invoice for the month.',
      operationId: 'generateMonthlyFees',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: { month: '2024-08', due_date: '2024-08-31' },
          },
        },
      },
      responses: {
        200: { description: 'Generation result', content: { 'application/json': { example: { success: true, data: { generated: 245, skipped: 3 } } } } },
        403: { description: 'Admin only' },
      },
    },
  },

  '/api/fees/payments': {
    get: {
      tags: ['Fees'],
      summary: 'List payments',
      operationId: 'listPayments',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'student_id',  in: 'query', schema: { type: 'integer' } },
        { name: 'date_from',   in: 'query', schema: { type: 'string', format: 'date' } },
        { name: 'date_to',     in: 'query', schema: { type: 'string', format: 'date' } },
      ],
      responses: { 200: { description: 'Payment list' } },
    },
    post: {
      tags: ['Fees'],
      summary: 'Record a payment',
      description: 'Records a payment against an invoice. Updates invoice status automatically.',
      operationId: 'recordPayment',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: {
              invoice_id: 100, amount: 4500,
              payment_date: '2024-07-15', payment_method: 'cash',
              transaction_ref: null, remarks: '',
            },
          },
        },
      },
      responses: {
        201: { description: 'Payment recorded, receipt number returned', content: { 'application/json': { example: { success: true, data: { receipt_no: 'RCP-2024-055', new_status: 'partial' } } } } },
        400: { description: 'Amount exceeds outstanding balance' },
        403: { description: 'Admin only' },
      },
    },
  },

  '/api/fees/reports/outstanding': {
    get: {
      tags: ['Fees'],
      summary: 'Outstanding balances report',
      description: 'Returns all students with unpaid/partial/overdue invoices, sorted by outstanding amount.',
      operationId: 'getOutstanding',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'class_id', in: 'query', schema: { type: 'integer' } },
        { name: 'month',    in: 'query', schema: { type: 'string' } },
      ],
      responses: {
        200: {
          description: 'Outstanding balances',
          content: {
            'application/json': {
              example: {
                success: true,
                data: [{ student_id: 5, full_name: 'Hamza Raza', outstanding: 9500, invoice_count: 2 }],
              },
            },
          },
        },
      },
    },
  },

  '/api/fees/send-reminders': {
    post: {
      tags: ['Fees'],
      summary: 'Send fee reminders',
      description: 'Sends email/SMS reminders to parents of students with outstanding fees. **Admin only.**',
      operationId: 'sendFeeReminders',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: { class_id: null, month: '2024-07', channel: 'email' },
          },
        },
      },
      responses: {
        200: { description: 'Reminders queued', content: { 'application/json': { example: { success: true, data: { sent: 12 } } } } },
        403: { description: 'Admin only' },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // TRANSPORT
  // ════════════════════════════════════════════════════════════════════════════
  '/api/transport/buses': {
    get: {
      tags: ['Transport'],
      summary: 'List buses',
      description: 'Returns all buses with driver and route assignments.',
      operationId: 'listBuses',
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: 'Bus list',
          content: { 'application/json': { example: { success: true, data: [{ id: 1, bus_number: 'SKL-001', capacity: 40, driver_name: 'Imran Ali', route_name: 'Route A – Johar Town', status: 'active' }] } } },
        },
      },
    },
    post: {
      tags: ['Transport'],
      summary: 'Add bus',
      operationId: 'createBus',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: { 'application/json': { example: { bus_number: 'SKL-002', capacity: 35, make: 'Toyota', model: 'Coaster', year: 2020 } } },
      },
      responses: { 201: { description: 'Bus created' }, 403: { description: 'Admin only' } },
    },
  },

  '/api/transport/routes': {
    get: {
      tags: ['Transport'],
      summary: 'List transport routes',
      operationId: 'listRoutes',
      security: [{ BearerAuth: [] }],
      responses: { 200: { description: 'Route list with stops and assigned students' } },
    },
    post: {
      tags: ['Transport'],
      summary: 'Create route',
      operationId: 'createRoute',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: {
              name: 'Route B – DHA', stops: ['DHA Phase 1', 'DHA Phase 3', 'School'],
              morning_departure: '07:00', evening_departure: '14:00',
            },
          },
        },
      },
      responses: { 201: { description: 'Route created' } },
    },
  },

  '/api/transport/drivers': {
    get: {
      tags: ['Transport'],
      summary: 'List drivers',
      operationId: 'listDrivers',
      security: [{ BearerAuth: [] }],
      responses: { 200: { description: 'Driver list' } },
    },
    post: {
      tags: ['Transport'],
      summary: 'Add driver',
      operationId: 'createDriver',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            example: { full_name: 'Imran Ali', phone: '+923331234567', cnic: '35201-1234567-1', license_no: 'LHR-2020-001', license_expiry: '2026-12-31' },
          },
        },
      },
      responses: { 201: { description: 'Driver created' } },
    },
  },

  '/api/tracking/location/{busId}': {
    get: {
      tags: ['Transport'],
      summary: 'Get live bus location',
      description: 'Returns the last known GPS coordinates for a bus. Used by the live tracking map.',
      operationId: 'getBusLocation',
      security: [{ BearerAuth: [] }],
      parameters: [{ name: 'busId', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: {
        200: {
          description: 'Last GPS fix',
          content: {
            'application/json': {
              example: { success: true, data: { bus_id: 1, lat: 31.5204, lng: 74.3587, speed: 35, heading: 180, timestamp: '2024-07-15T08:15:00Z' } },
            },
          },
        },
        404: { description: 'Bus not found or no location data' },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // CHATBOT
  // ════════════════════════════════════════════════════════════════════════════
  '/api/chatbot/query': {
    post: {
      tags: ['Chatbot'],
      summary: 'Send a query to the school assistant',
      description: `Natural-language query endpoint. The chatbot resolves the user's intent and queries the relevant tables.

**Supported intents:**
- \`attendance\` — "What is my attendance?", "Who was absent today?"
- \`fees\` — "Do I have pending fees?", "Show fee defaulters"
- \`timetable\` — "Show my timetable", "What class do I have at 10am?"
- \`transport\` — "Where is my bus?", "What time does the bus arrive?"
- \`homework\` — "What homework is due?", "Show pending assignments"
- \`announcements\` — "Latest notices", "Any upcoming events?"
- \`general\` — Greetings, off-topic questions (handled gracefully)

**Rate limit:** 60 requests / minute per user.`,
      operationId: 'chatbotQuery',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ChatbotQuery' },
            examples: {
              fees: { summary: 'Check pending fees', value: { query: 'Do I have any pending fees?' } },
              attendance: { summary: 'Check attendance', value: { query: 'What is my attendance this month?' } },
              bus: { summary: 'Bus location', value: { query: 'Where is the school bus right now?' } },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Chatbot response',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ChatbotResponse' },
              example: {
                success: true,
                data: {
                  intent: 'fees',
                  response: 'You have 1 unpaid invoice of PKR 4,500 (July 2024) due on 31 July 2024.',
                },
              },
            },
          },
        },
        401: { description: 'Unauthorized' },
        429: { description: 'Rate limit exceeded (60/min)' },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // ANNOUNCEMENTS
  // ════════════════════════════════════════════════════════════════════════════
  '/api/announcements': {
    get: {
      tags: ['Announcements'],
      summary: 'List announcements',
      description: 'Returns announcements visible to the authenticated user based on their role and class.',
      operationId: 'listAnnouncements',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'page',  in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
      ],
      responses: {
        200: { description: 'Announcement list', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaginatedResponse' } } } },
      },
    },
    post: {
      tags: ['Announcements'],
      summary: 'Create announcement',
      operationId: 'createAnnouncement',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Announcement' },
            example: {
              title: 'Parent-Teacher Meeting',
              body: 'PTM is scheduled for 20th July from 9am to 1pm.',
              target_role: 'parent',
              is_pinned: true,
            },
          },
        },
      },
      responses: {
        201: { description: 'Announcement created and push notifications sent' },
        403: { description: 'Admin or teacher only' },
      },
    },
  },

  // ════════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ════════════════════════════════════════════════════════════════════════════
  '/api/dashboard/stats': {
    get: {
      tags: ['Dashboard'],
      summary: 'Admin dashboard KPIs',
      description: 'Returns top-level school statistics. Heavy endpoint — rate-limited to 20 requests/minute.',
      operationId: 'getDashboardStats',
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: 'Dashboard KPIs',
          content: {
            'application/json': {
              example: {
                success: true,
                data: {
                  totalStudents: 350, totalTeachers: 24,
                  attendanceToday: { present: 320, absent: 30, percentage: 91.4 },
                  feeCollectedThisMonth: 850000, pendingFeeCount: 12,
                  upcomingEvents: 3,
                },
              },
            },
          },
        },
        403: { description: 'Admin or teacher only' },
      },
    },
  },

  '/api/dashboard/teacher': {
    get: {
      tags: ['Dashboard'],
      summary: 'Teacher dashboard',
      description: 'Returns data scoped to the requesting teacher: their classes, today\'s attendance status, homework due, and timetable.',
      operationId: 'getTeacherDashboard',
      security: [{ BearerAuth: [] }],
      responses: {
        200: { description: 'Teacher dashboard data' },
        403: { description: 'Teacher role required' },
      },
    },
  },

  '/api/dashboard/student': {
    get: {
      tags: ['Dashboard'],
      summary: 'Student dashboard',
      description: 'Returns the student\'s own attendance summary, upcoming exams, fee status, and homework.',
      operationId: 'getStudentDashboard',
      security: [{ BearerAuth: [] }],
      responses: {
        200: { description: 'Student dashboard data' },
        403: { description: 'Student role required' },
      },
    },
  },

  '/api/dashboard/parent': {
    get: {
      tags: ['Dashboard'],
      summary: 'Parent dashboard',
      description: 'Returns data for all children linked to the authenticated parent account.',
      operationId: 'getParentDashboard',
      security: [{ BearerAuth: [] }],
      responses: {
        200: { description: 'Parent dashboard data including child attendance, fees, and recent events' },
        403: { description: 'Parent role required' },
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SWAGGER-JSDOC OPTIONS
// ─────────────────────────────────────────────────────────────────────────────
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'School Management System — API Reference',
      version: '1.0.0',
      description: `
## Overview
A comprehensive REST API for managing school operations — students, teachers, attendance, fees, transport, and more.

## Authentication
All protected endpoints require a **Bearer JWT** token in the \`Authorization\` header:
\`\`\`
Authorization: Bearer <access_token>
\`\`\`
Obtain a token via **POST /api/auth/login**. Access tokens expire in **15 minutes**; use **POST /api/auth/refresh** to get a new one.

## Base URL
- **Development:** \`http://localhost:5000\`
- **Production:** \`https://studentmanagement-backend.vercel.app\`

## Response Envelope
All responses follow a consistent shape:
\`\`\`json
{ "success": true,  "data": { ... } }           // single object
{ "success": true,  "data": [ ... ], "pagination": { ... } }  // list
{ "success": false, "message": "Error reason" }  // error
\`\`\`

## Rate Limits
| Endpoint Group          | Limit             |
|-------------------------|-------------------|
| Login                   | 20 req / 15 min   |
| General API             | 300 req / min     |
| Dashboard / Analytics   | 20 req / min      |
| CSV / Excel Exports     | 3 req / hour      |
| Password Reset Email    | 3 req / hour      |

## Roles
| Role    | Description                                      |
|---------|--------------------------------------------------|
| admin   | Full access to all endpoints                     |
| teacher | Read students, mark attendance, submit marks     |
| student | Own data only — attendance, fees, timetable      |
| parent  | Child data — attendance, fees, announcements     |
      `,
      contact: {
        name: 'School Management Support',
        email: 'support@school.edu',
      },
      license: {
        name: 'Proprietary',
      },
    },
    servers: [
      { url: 'http://localhost:5000',                                  description: 'Local development' },
      { url: 'https://studentmanagement-backend.vercel.app',          description: 'Production' },
    ],
    components,
    paths,
    security: [{ BearerAuth: [] }],
    tags: [
      { name: 'System',        description: 'Health checks and server status' },
      { name: 'Auth',          description: 'Authentication, sessions, password management' },
      { name: 'Dashboard',     description: 'Role-specific dashboard endpoints' },
      { name: 'Students',      description: 'Student CRUD, import/export, credentials' },
      { name: 'Teachers',      description: 'Teacher CRUD, class and subject assignments' },
      { name: 'Classes',       description: 'Class and section management' },
      { name: 'Attendance',    description: 'Daily attendance marking and reports' },
      { name: 'Fees',          description: 'Invoices, payments, structures, and reports' },
      { name: 'Transport',     description: 'Buses, routes, drivers, and live tracking' },
      { name: 'Chatbot',       description: 'AI school assistant — natural language queries' },
      { name: 'Announcements', description: 'School-wide and class-specific notices' },
    ],
  },
  apis: ['./src/routes/*.js', './src/controllers/*.js'],
};

// ─────────────────────────────────────────────────────────────────────────────
const swaggerSpec = swaggerJsdoc(options);

const swaggerUiOptions = {
  explorer: true,
  customSiteTitle: 'School Management — API Docs',
  customCss: `
    .swagger-ui .topbar { display: none }
    .swagger-ui .info h2.title { font-size: 1.8rem; }
    .swagger-ui .scheme-container { background: #f7f9fc; padding: 12px 24px; }
  `,
};

module.exports = { swaggerSpec, swaggerUiOptions };
