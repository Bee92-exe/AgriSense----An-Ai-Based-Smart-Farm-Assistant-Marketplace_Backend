import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Resolve relative to this file, not process.cwd(): the API must start with the
// same environment whether it is launched from Backend/ or the repository root.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const rawPort = process.env.PORT;
// This shell exports PORT=0. Treat it as unset so the server does not bind an
// ephemeral port that no client can discover.
const port = !rawPort || rawPort === '0' ? 3000 : Number(rawPort);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.number().int().min(1).max(65535),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DIRECT_URL: z.string().min(1).optional(),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().min(1).default('agrisense-api'),
  JWT_AUDIENCE: z.string().min(1).default('agrisense-mobile'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  AUTH_RESET_TOKEN_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  CORS_ORIGINS: z.string().default(''),
  GEMINI_API_KEY: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('crop-scans'),
  WEATHER_API_KEY: z.string().optional(),
  WEATHER_CACHE_MINUTES: z.coerce.number().int().min(1).max(180).default(15),
  /// Comma-separated RSS URLs for the Krishi Barta ingest.
  RSS_FEEDS: z.string().default(''),
  PUBLIC_API_URL: z.string().url().optional(),
  AI_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
});

const parsed = envSchema.safeParse({ ...process.env, PORT: port });

if (!parsed.success) {
  const issues = parsed.error.issues.map((issue) => {
    const key = issue.path.join('.') || 'env';
    return `  - ${key}: ${issue.message}`;
  });
  console.error(`[env] Invalid configuration:\n${issues.join('\n')}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
};
