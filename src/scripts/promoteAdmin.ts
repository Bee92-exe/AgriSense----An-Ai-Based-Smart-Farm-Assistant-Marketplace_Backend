import prisma from '../config/db';
import { normalizeMobile } from '../lib/phone';

/**
 * Promotes an existing account to administrator. The account must already have
 * registered normally, so no password ever has to pass through this command.
 *
 *   npm run promote-admin -- 01712345678
 */
async function main(): Promise<void> {
  const rawMobile = process.argv[2];
  if (!rawMobile) {
    console.error('Usage: npm run promote-admin -- 01712345678');
    process.exitCode = 1;
    return;
  }

  const mobile = normalizeMobile(rawMobile);
  if (!mobile) {
    console.error('That is not a valid Bangladeshi mobile number.');
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({
    where: { mobileNumber: mobile },
    select: { id: true, name: true, role: true, status: true },
  });

  if (!user) {
    console.error(
      `No account exists for ${mobile}. Register it in the app first, then rerun this command.`,
    );
    process.exitCode = 1;
    return;
  }

  if (user.role === 'ADMIN' && user.status === 'ACTIVE') {
    console.log(`${mobile} is already an active administrator.`);
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      role: 'ADMIN',
      status: 'ACTIVE',
      tokenVersion: { increment: 1 },
      failedLoginAttempts: 0,
      lockedUntil: null,
    },
  });

  console.log(`Promoted ${mobile} (${user.name}) to ADMIN. Existing sessions were revoked.`);
}

main()
  .catch((error: unknown) => {
    console.error('[promote-admin] failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
