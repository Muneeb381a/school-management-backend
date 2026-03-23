/**
 * Jest global setup — loads env for tests.
 * Uses a test-specific DATABASE_URL if TEST_DATABASE_URL is set.
 */
require('dotenv').config({ path: '.env.test', override: false });
require('dotenv').config(); // fallback to .env

// Suppress console noise in tests unless DEBUG_TESTS=1
if (!process.env.DEBUG_TESTS) {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
}
