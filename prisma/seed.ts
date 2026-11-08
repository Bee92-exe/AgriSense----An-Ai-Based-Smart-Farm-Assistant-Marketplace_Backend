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

  const existing = await prisma.user.findUnique({
    where: { mobileNumber },
    select: { role: true, status: true },
  });

  if (existing) {
    // Provisioning must never change, escalate or unlock an account that already
    // exists. An earlier version rewrote the password of a working administrator
    // here, and its role update would also have promoted any account whose
    // number appeared in ADMIN_MOBILE. A re-run is now a no-op.
    console.log(
      `${mobileNumber} already exists (${existing.role}, ${existing.status}). Nothing was changed — this command never edits an existing account.`,
    );
    return;
  }

  const passwordHash = await hashPassword(password);

  await prisma.user.create({
    data: { name, mobileNumber, passwordHash, role: 'ADMIN', status: 'ACTIVE' },
  });

  console.log(`Admin account created: ${mobileNumber}`);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
