import path from 'path';
import fs from 'fs';
import express from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import prisma from './config/db';
import { AppError, banglaForFailure } from './lib/errors';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import authRoutes from './routes/authRoutes';
import userRoutes from './routes/userRoutes';
import diagnosisRoutes from './routes/diagnosisRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import productRoutes from './routes/productRoutes';
import vendorRoutes from './routes/vendorRoutes';
import expertRoutes from './routes/expertRoutes';
import aiRoutes from './routes/aiRoutes';
import adminRoutes from './routes/adminRoutes';
import newsRoutes from './routes/newsRoutes';
import weatherRoutes from './routes/weatherRoutes';
import { cropRouter, metaRouter } from './routes/cropRoutes';

const app = express();

app.disable('x-powered-by');
app.use(helmet());

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // No Origin header: native mobile clients and curl, not a browser.
    if (
      !origin ||
      env.CORS_ORIGINS.includes(origin) ||
      (env.NODE_ENV === 'development' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
    ) {
      callback(null, true);
      return;
    }
    callback(new AppError(403, 'origin_not_allowed', 'Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
};
app.use(cors(corsOptions));

app.use(express.json({ limit: '100kb' }));

// Older controllers still return a direct JSON error object. Put Bangla on
// every one of them centrally instead of letting an English sentence leak.
app.use((_req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const payload = body as Record<string, unknown>;
      if (payload.success === false && !payload.message_bn) {
        payload.message_bn = banglaForFailure(
          typeof payload.code === 'string' ? payload.code : undefined,
          res.statusCode,
        );
      }
    }
    return sendJson(body);
  }) as typeof res.json;
  next();
});

const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
// Local files are a development-only fallback. Production uses a private
// Supabase bucket with short-lived signed URLs.
if (env.NODE_ENV !== 'production') {
  app.use('/uploads', express.static(uploadsDir));
}

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/diagnosis', diagnosisRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/products', productRoutes);
app.use('/api/vendor', vendorRoutes);
app.use('/api/expert', expertRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/voice', aiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/weather', weatherRoutes);
app.use('/api/meta', metaRouter);
app.use('/api/crops', cropRouter);
// The app calls the calendar at the top level (`GET /calendar?crop=`).
app.use('/api/calendar', cropRouter);

app.get('/health', async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ status: 'ok', message: 'AgriSense Backend is running' });
});

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

