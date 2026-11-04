import { env } from './config/env';
import app from './app';
import prisma from './config/db';

const server = app.listen(env.PORT, () => {
  console.log(`AgriSense API listening on http://127.0.0.1:${env.PORT} (${env.NODE_ENV})`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
