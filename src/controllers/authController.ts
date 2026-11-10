import crypto from 'crypto';
import { Request, Response } from 'express';
import { Prisma, Role, UserStatus } from '@prisma/client';
import prisma from '../config/db';
import { env } from '../config/env';
import { AppError } from '../lib/errors';
import { burnPasswordComparison, hashPassword, verifyPassword } from '../lib/password';
import { publicUserSelect, toPublicUser } from '../lib/serializers';
import {
  hashToken,
  issueSession,
  revokeSession,
  rotateSession,
  type IssuedSession,
} from '../lib/tokens';
import type { AuthRequest } from '../middleware/authMiddleware';
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  RefreshInput,
  RegisterInput,
  ResetPasswordInput,
} from '../validation/auth';

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const INVALID_CREDENTIALS = 'Invalid mobile number or password';

/** Maps the internal session names to the API_SPEC wire names. */
function sessionPayload(session: IssuedSession) {
  return {
    access: session.accessToken,
    refresh: session.refreshToken,
    expires_in: session.expiresIn,
  };
}

async function recordFailedLogin(userId: string, currentAttempts: number): Promise<void> {
  const attempts = currentAttempts + 1;
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: attempts,
      lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_DURATION_MS) : null,
    },
  });
}

export const register = async (req: Request, res: Response): Promise<void> => {
  const input = req.body as RegisterInput;
  const passwordHash = await hashPassword(input.password);
  const role = input.role.toUpperCase() as Role;
  const status = UserStatus.PENDING;

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: input.name,
          mobileNumber: input.mobile,
          passwordHash,
          role,
          status,
          location: input.district,
        },
        select: { ...publicUserSelect, tokenVersion: true },
      });

      if (role === Role.FARMER) {
        await tx.farmer.create({
          data: { userId: user.id, landSize: input.farm_size ?? null },
        });
      } else if (role === Role.VENDOR) {
        await tx.vendor.create({
          data: {
            userId: user.id,
            shopName: input.shop_name!,
            businessLicense: input.license_no!,
            verificationStatus: 'PENDING',
          },
        });
      } else {
        await tx.expert.create({
          data: {
            userId: user.id,
            specialization: input.specialization!,
            certification: input.certification!,
          },
        });
      }

      // The profile row was created after the user, so re-read the complete
      // public projection before returning it to the client.
      const fresh = await tx.user.findUnique({
        where: { id: user.id },
        select: { ...publicUserSelect, tokenVersion: true },
      });
      if (!fresh) throw new AppError(500, 'internal_error', 'Account creation failed');
      return fresh;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(409, 'mobile_taken', 'An account with this mobile number already exists', undefined, 'এই মোবাইল নম্বর দিয়ে আগে থেকেই অ্যাকাউন্ট আছে।');
    }
    throw error;
  }

  const session = await issueSession({
    id: created.id,
    role: created.role,
    tokenVersion: created.tokenVersion,
  });

  res.status(201).json({
    success: true,
    user: toPublicUser(created),
    ...sessionPayload(session),
  });
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { mobile, password } = req.body as LoginInput;

  const user = await prisma.user.findUnique({
    where: { mobileNumber: mobile },
    select: {
      ...publicUserSelect,
      passwordHash: true,
      tokenVersion: true,
      failedLoginAttempts: true,
      lockedUntil: true,
    },
  });

  if (!user) {
    // Spend comparable work so a wrong number and a wrong password look alike.
    await burnPasswordComparison(password);
    throw new AppError(401, 'invalid_credentials', INVALID_CREDENTIALS, undefined, 'মোবাইল নম্বর বা পাসওয়ার্ড ঠিক নেই।');
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  const locked = user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now();

  if (!passwordOk || locked) {
    if (!passwordOk) await recordFailedLogin(user.id, user.failedLoginAttempts);
    throw new AppError(401, 'invalid_credentials', INVALID_CREDENTIALS, undefined, 'মোবাইল নম্বর বা পাসওয়ার্ড ঠিক নেই।');
  }

  // Only reveal an account state to someone who proved they own the password.
  if (user.status === UserStatus.SUSPENDED) {
    throw new AppError(403, 'account_suspended', 'This account has been suspended', undefined, 'এই অ্যাকাউন্টটি স্থগিত করা হয়েছে। সহায়তা কেন্দ্রে যোগাযোগ করুন।');
  }
  if (user.status === UserStatus.REMOVED) {
    throw new AppError(403, 'account_removed', 'This account has been removed', undefined, 'এই অ্যাকাউন্টটি মুছে ফেলা হয়েছে।');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    select: { ...publicUserSelect, tokenVersion: true },
  });

  const session = await issueSession({
    id: updated.id,
    role: updated.role,
    tokenVersion: updated.tokenVersion,
  });

  res.status(200).json({
    success: true,
    user: toPublicUser(updated),
    ...sessionPayload(session),
  });
};

export const refresh = async (req: Request, res: Response): Promise<void> => {
  const { refresh } = req.body as RefreshInput;
  const session = await rotateSession(refresh);

  if (!session) {
    throw new AppError(401, 'invalid_refresh_token', 'Your session has expired. Please sign in again.');
  }

  res.status(200).json({ success: true, ...sessionPayload(session) });
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  const { refresh } = req.body as RefreshInput;
  await revokeSession(refresh);
  res.status(204).end();
};

export const changePassword = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const { currentPassword, newPassword } = req.body as ChangePasswordInput;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, passwordHash: true },
  });
  if (!user) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const currentOk = await verifyPassword(user.passwordHash, currentPassword);
  if (!currentOk) {
    throw new AppError(400, 'invalid_current_password', 'Current password is incorrect');
  }

  const passwordHash = await hashPassword(newPassword);

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
      select: { id: true, role: true, tokenVersion: true },
    });

    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    return next;
  });

  // The user is changing their own password; keep this device signed in.
  const session = await issueSession(updated);

  res.status(200).json({
    success: true,
    message: 'Password updated',
    ...sessionPayload(session),
  });
};

/**
 * Password reset by SMS or email is not implemented, and no other channel can
 * deliver a one-time code.
 *
 * The previous implementation wrote the raw token to the server log, which made
 * every account resettable by anyone who could read that log — including any
 * operator, and any log-shipping pipeline. That is an account-takeover path, so
 * this now fails closed in every environment instead of pretending to send a
 * code. Recovery is an administrator-initiated reset from the console.
 */
export const forgotPassword = async (_req: Request, _res: Response): Promise<void> => {
  throw new AppError(
    503,
    'reset_unavailable',
    'Password reset is not available yet',
    undefined,
    'পাসওয়ার্ড রিসেট এখনো চালু হয়নি। প্ল্যাটফর্ম অ্যাডমিনের সাথে যোগাযোগ করুন।',
  );
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  const { token, newPassword } = req.body as ResetPasswordInput;
  const tokenHash = hashToken(token);

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, usedAt: true, expiresAt: true },
  });

  if (!record || record.usedAt || record.expiresAt.getTime() <= Date.now()) {
    throw new AppError(400, 'invalid_reset_token', 'This reset code is invalid or has expired');
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    if (claimed.count !== 1) {
      throw new AppError(400, 'invalid_reset_token', 'This reset code is invalid or has expired');
    }

    await tx.user.update({
      where: { id: record.userId },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await tx.refreshToken.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  res.status(200).json({ success: true, message: 'Password has been reset. Please sign in.' });
};
