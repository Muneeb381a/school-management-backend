const request = require('supertest');
// Import the express app directly without starting server
// We need a testApp export from index.js — but to avoid breaking things,
// create a minimal test server here instead:

const express = require('express');
const cors = require('cors');
require('dotenv').config();

// Load auth controller + routes
let app;

beforeAll(() => {
  // Only run if DATABASE_URL is set (skip in environments without DB)
  if (!process.env.DATABASE_URL) {
    console.warn('Skipping auth tests: DATABASE_URL not set');
    return;
  }

  const authRoutes = require('../src/routes/authRoutes');
  app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
});

describe('POST /api/auth/login', () => {
  it('returns 400 if username is missing', async () => {
    if (!app) return;
    const res = await request(app)
      .post('/api/auth/login')
      .send({ password: 'test123' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 401 for invalid credentials', async () => {
    if (!app) return;
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'nonexistent@test.com', password: 'wrongpassword123!' });
    expect([401, 429]).toContain(res.status);
  });

  it('returns 400 if password is missing', async () => {
    if (!app) return;
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'admin@school.com' });
    expect(res.status).toBe(400);
  });
});
