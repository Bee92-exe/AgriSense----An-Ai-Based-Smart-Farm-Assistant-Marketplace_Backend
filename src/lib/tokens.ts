import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Prisma, Role } from '@prisma/client';
import prisma from '../config/db';
import { env } from '../config/env';

export interface SessionUser {
  id: string;
  role: Role;
  tokenVersion: number;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  expiresIn: number;
}

const REFRESH_TOKEN_BYTES = 32;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function signAccessToken(user: SessionUser): string {
  return jwt.sign({ role: user.role, tv: user.tokenVersion }, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    jwtid: crypto.randomUUID(),
  });
}

/** Throws when the token is expired, tampered with, or intended for another audience. */
export function verifyAccessToken(token: string): { sub: string; role: Role; tv: number } {
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  if (typeof decoded === 'string') throw new Error('Invalid access token payload');

  const { sub, role, tv } = decoded as jwt.JwtPayload & { role?: Role; tv?: number };
  if (!sub || !role || typeof tv !== 'number') throw new Error('Invalid access token payload');

  return { sub, role, tv };
}

function newRefreshToken(): { raw: string; hash: string } {
  const raw = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export async function issueSession(user: SessionUser): Promise<IssuedSession> {
  const refreshToken = newRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  await prisma.refreshToken.create({
    data: { tokenHash: refreshToken.hash, userId: user.id, expiresAt },
  });

  return {
    accessToken: signAccessToken(user),
    refreshToken: refreshToken.raw,
    expiresAt,
    expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
  };
}

async function revokeAllSessions(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  // Invalidates every access token already issued to this account.
  await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
}

/**
 * Rotates a refresh token. A token that was already rotated or revoked is
 * treated as stolen: every session for that user is revoked.
 */
export async function rotateSession(rawToken: string): Promise<IssuedSession | null> {
  const tokenHash = hashToken(rawToken);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.refreshToken.findUnique({
      where: { tokenHash },
      select: {
        userId: true,
        revokedAt: true,
        replacedByTokenHash: true,
        expiresAt: true,
        user: { select: { id: true, role: true, tokenVersion: true, status: true } },
      },
    });

    if (!existing) return null;

    // A token that was already rotated is a replay: assume theft and revoke
    // every session. A token revoked by logout or a password change is simply
    // dead — replaying it must not log out the user's other devices.
    if (existing.replacedByTokenHash) {
      await revokeAllSessions(tx, existing.userId);
      return null;
    }

    if (existing.revokedAt) return null;

    if (existing.expiresAt.getTime() <= Date.now()) return null;
    if (existing.user.status === 'SUSPENDED') return null;

    const next = newRefreshToken();
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

    // Conditional update closes the race where two requests rotate the same
    // token at once: only one of them can win.
    const rotated = await tx.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date(), replacedByTokenHash: next.hash },
    });

    if (rotated.count !== 1) {
      await revokeAllSessions(tx, existing.userId);
      return null;
    }

    await tx.refreshToken.create({
      data: { tokenHash: next.hash, userId: existing.userId, expiresAt },
    });

    return {
      accessToken: signAccessToken({
        id: existing.user.id,
        role: existing.user.role,
        tokenVersion: existing.user.tokenVersion,
      }),
      refreshToken: next.raw,
      expiresAt,
      expiresIn: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    };
  });
}

/** Revokes one refresh token. Always succeeds, so logout cannot be used as an oracle. */
export async function revokeSession(rawToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
