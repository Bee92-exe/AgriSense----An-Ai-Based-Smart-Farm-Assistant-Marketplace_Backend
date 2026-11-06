import { env } from '../src/config/env';
import prisma from '../src/config/db';
import { hashPassword } from '../src/lib/password';
import { normalizeMobile } from '../src/lib/phone';

/**
 * Creates or updates the administrator account from environment variables.
 * There is deliberately no default password: a missing configuration creates
 * nothing, and a missing configuration in production fails the command.
 */
async function main(): Promise<void> {
  const rawMobile = process.env.ADMIN_MOBILE;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME ?? 'AgriSense Admin';

  if (!rawMobile || !password) {
    console.log('ADMIN_MOBILE / ADMIN_PASSWORD are not set — no admin account was created.');
    if (env.NODE_ENV === 'production') process.exitCode = 1;
    return;
  }

  const mobileNumber = normalizeMobile(rawMobile);
  if (!mobileNumber) throw new Error('ADMIN_MOBILE is not a valid Bangladeshi mobile number');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');

  const passwordHash = await hashPassword(password);

  await prisma.user.upsert({
    where: { mobileNumber },
    update: { name, passwordHash, role: 'ADMIN', status: 'ACTIVE' },
    create: { name, mobileNumber, passwordHash, role: 'ADMIN', status: 'ACTIVE' },
  });

  console.log(`Admin account ready: ${mobileNumber}`);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
