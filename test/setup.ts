process.env.NODE_ENV = 'test';
// Keep the per-IP limiter from tripping across the suite; account lockout is
// still exercised directly in the tests.
process.env.AUTH_RATE_LIMIT_MAX = '1000';
