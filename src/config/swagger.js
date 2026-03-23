'use strict';

const swaggerJsdoc = require('swagger-jsdoc');

// ---------------------------------------------------------------------------
// Reusable schema components
// ---------------------------------------------------------------------------
const components = {
  securitySchemes: {
    BearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description: 'Enter your JWT access token',
    },
  },
  schemas: {
    // ---- Domain models ----------------------------------------------------
    Student: {
      type: 'object',
      properties: {
        id:           { type: 'integer', example: 1 },
        full_name:    { type: 'string',  example: 'Ali Hassan' },
        grade:        { type: 'string',  example: '5' },
        section:      { type: 'string',  example: 'A' },
        status: {
          type: 'string',
          enum: ['active', 'inactive', 'suspended', 'graduated'],
          example: 'active',
        },
        gender:        { type: 'string', example: 'male' },
        father_name:   { type: 'string', example: 'Hassan Khan' },
        father_phone:  { type: 'string', example: '+923001234567' },
        admission_no:  { type: 'string', example: 'ADM-2024-001' },
        created_at:    { type: 'string', format: 'date-time' },
      },
    },

    Teacher: {
      type: 'object',
      properties: {
        id:        { type: 'integer', example: 1 },
        full_name: { type: 'string',  example: 'Sarah Ahmed' },
        phone:     { type: 'string',  example: '+923009876543' },
        email:     { type: 'string',  format: 'email', example: 'sarah@school.edu' },
        status: {
          type: 'string',
          enum: ['active', 'inactive', 'on_leave'],
          example: 'active',
        },
        join_date: { type: 'string', format: 'date', example: '2022-08-15' },
      },
    },

    FeeInvoice: {
      type: 'object',
      properties: {
        id:           { type: 'integer', example: 100 },
        student_id:   { type: 'integer', example: 1 },
        amount:       { type: 'number',  format: 'float', example: 5000.00 },
        due_date:     { type: 'string',  format: 'date', example: '2024-07-31' },
        paid_date:    { type: 'string',  format: 'date', nullable: true },
        status: {
          type: 'string',
          enum: ['unpaid', 'paid', 'partial', 'overdue'],
          example: 'unpaid',
        },
        month:        { type: 'string',  example: '2024-07' },
        created_at:   { type: 'string',  format: 'date-time' },
      },
    },

    Attendance: {
      type: 'object',
      properties: {
        id:         { type: 'integer', example: 200 },
        student_id: { type: 'integer', example: 1 },
        date:       { type: 'string',  format: 'date', example: '2024-07-15' },
        status: {
          type: 'string',
          enum: ['present', 'absent', 'late', 'excused'],
          example: 'present',
        },
        recorded_by: { type: 'integer', example: 3, description: 'Teacher user id' },
        created_at:  { type: 'string',  format: 'date-time' },
      },
    },

    // ---- Generic envelopes ------------------------------------------------
    ErrorResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string',  example: 'Unauthorized' },
      },
      required: ['success', 'message'],
    },

    SuccessResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data:    { type: 'object' },
      },
      required: ['success', 'data'],
    },

    PaginatedResponse: {
      type: 'object',
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
      required: ['success', 'data', 'pagination'],
    },
  },
};

// ---------------------------------------------------------------------------
// Inline path definitions (example endpoints)
// ---------------------------------------------------------------------------
const paths = {
  // -- Health check ---------------------------------------------------------
  '/api/health': {
    get: {
      tags: ['System'],
      summary: 'Health check',
      description: 'Returns 200 when the API server is running.',
      operationId: 'healthCheck',
      responses: {
        200: {
          description: 'API is healthy',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SuccessResponse' },
              example: { success: true, data: { status: 'ok', uptime: 12345 } },
            },
          },
        },
      },
    },
  },

  // -- Auth login -----------------------------------------------------------
  '/api/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Login with username / password',
      description: 'Authenticates a user and returns a JWT access token plus a refresh token.',
      operationId: 'login',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['username', 'password'],
              properties: {
                username: { type: 'string', example: 'admin' },
                password: { type: 'string', format: 'password', example: 'secret123' },
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
              schema: { $ref: '#/components/schemas/SuccessResponse' },
              example: {
                success: true,
                data: {
                  accessToken: '<jwt>',
                  refreshToken: '<jwt>',
                  user: { id: 1, username: 'admin', role: 'admin' },
                },
              },
            },
          },
        },
        401: {
          description: 'Invalid credentials',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },

  // -- List students --------------------------------------------------------
  '/api/students': {
    get: {
      tags: ['Students'],
      summary: 'List students',
      description: 'Returns a paginated list of students. Requires authentication.',
      operationId: 'listStudents',
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: 'page',   in: 'query', schema: { type: 'integer', default: 1 } },
        { name: 'limit',  in: 'query', schema: { type: 'integer', default: 20 } },
        { name: 'search', in: 'query', schema: { type: 'string' },  description: 'Full-name or admission_no search' },
        { name: 'grade',  in: 'query', schema: { type: 'string' },  description: 'Filter by grade, e.g. "5"' },
        {
          name: 'status',
          in: 'query',
          schema: { type: 'string', enum: ['active', 'inactive', 'suspended', 'graduated'] },
        },
      ],
      responses: {
        200: {
          description: 'Paginated student list',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PaginatedResponse' },
            },
          },
        },
        401: {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },

    // -- Create student -----------------------------------------------------
    post: {
      tags: ['Students'],
      summary: 'Create a student',
      description: 'Creates a new student record. Admin only.',
      operationId: 'createStudent',
      security: [{ BearerAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Student' },
          },
        },
      },
      responses: {
        201: {
          description: 'Student created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SuccessResponse' },
            },
          },
        },
        400: {
          description: 'Validation error',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        401: {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        403: {
          description: 'Forbidden — admin role required',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },

  // -- Dashboard stats ------------------------------------------------------
  '/api/dashboard/stats': {
    get: {
      tags: ['Dashboard'],
      summary: 'Dashboard KPIs',
      description: 'Returns key performance indicators for the dashboard. Accessible by admin and teacher roles.',
      operationId: 'getDashboardStats',
      security: [{ BearerAuth: [] }],
      responses: {
        200: {
          description: 'Dashboard statistics',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/SuccessResponse' },
              example: {
                success: true,
                data: {
                  totalStudents: 350,
                  totalTeachers: 24,
                  attendanceToday: 320,
                  feeCollectedThisMonth: 175000,
                  pendingFees: 3,
                },
              },
            },
          },
        },
        401: {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// swagger-jsdoc options
// ---------------------------------------------------------------------------
const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'School Management API',
      version: '1.0.0',
      description: 'REST API for school management system',
      contact: {
        name: 'School Management Support',
      },
    },
    servers: [
      {
        url: 'http://localhost:5000',
        description: 'Development server',
      },
      {
        url: 'https://studentmanagement-backend.vercel.app',
        description: 'Production server (placeholder)',
      },
    ],
    components,
    paths,
    security: [{ BearerAuth: [] }],
  },
  // Also scan route and controller files for @openapi / @swagger JSDoc tags
  apis: ['./src/routes/*.js', './src/controllers/*.js'],
};

// ---------------------------------------------------------------------------
// Build spec
// ---------------------------------------------------------------------------
const swaggerSpec = swaggerJsdoc(options);

// ---------------------------------------------------------------------------
// swagger-ui-express options
// ---------------------------------------------------------------------------
const swaggerUiOptions = {
  explorer: true,
  customSiteTitle: 'School API Docs',
  customCss: '.swagger-ui .topbar { display: none }',
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = { swaggerSpec, swaggerUiOptions };
