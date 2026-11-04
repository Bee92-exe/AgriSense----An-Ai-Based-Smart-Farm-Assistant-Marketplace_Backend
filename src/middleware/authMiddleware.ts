import { NextFunction, Request, Response } from 'express';
import type { Role, UserStatus } from '@prisma/client';
import prisma from '../config/db';
import { AppError } from '../lib/errors';
import { verifyAccessToken } from '../lib/tokens';

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  status: UserStatus;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export const authenticateToken = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AppError(401, 'unauthenticated', 'Authentication required');
    }

    const payload = verifyAccessToken(header.slice('Bearer '.length).trim());

    // Read the account on every request: a password change or suspension must
    // take effect immediately, not when the access token happens to expire.
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, name: true, role: true, status: true, tokenVersion: true },
    });

    if (!user || user.tokenVersion !== payload.tv) {
      throw new AppError(401, 'unauthenticated', 'Session is no longer valid');
    }

    req.user = {
      id: user.id,
      name: user.name,
      role: user.role,
      status: user.status,
    };
    next();
  } catch (error) {
    next(error instanceof AppError ? error : new AppError(401, 'unauthenticated', 'Session is no longer valid'));
  }
};

/**
 * Pending vendors and experts may hold a session so the app can show the
 * approval screen, but they must not reach role-specific operations.
 */
export const requireActiveAccount = (
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
): void => {
  if (!req.user) {
    next(new AppError(401, 'unauthenticated', 'Authentication required'));
    return;
  }

  if (req.user.status !== 'ACTIVE') {
    next(new AppError(403, 'account_pending', 'Your account is waiting for administrator approval'));
    return;
  }

  next();
};

export const requireRole =
  (...roles: Role[]) =>
  (req: AuthRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'unauthenticated', 'Authentication required'));
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new AppError(403, 'forbidden', 'You do not have permission to perform this action'));
      return;
    }

    next();
  };
