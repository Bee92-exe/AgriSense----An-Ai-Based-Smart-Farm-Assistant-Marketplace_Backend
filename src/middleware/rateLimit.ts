import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const WINDOW_MS = 15 * 60 * 1000;

const base = {
  windowMs: WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7' as const,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'rate_limited',
    message: 'Too many attempts. Please try again later.',
  },
};

export const authLimiter = rateLimit(base);

// Only failed logins consume the budget, so a busy legitimate user is not
// locked out by their own successful sign-ins.
export const loginLimiter = rateLimit({ ...base, skipSuccessfulRequests: true });

export const sensitiveLimiter = rateLimit({
  ...base,
  limit: Math.max(5, Math.ceil(env.AUTH_RATE_LIMIT_MAX / 3)),
});
