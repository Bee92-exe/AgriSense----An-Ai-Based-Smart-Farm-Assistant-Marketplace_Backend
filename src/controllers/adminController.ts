import crypto from 'crypto';
import { Request, Response } from 'express';
import { Prisma, Role, UserStatus } from '@prisma/client';
import prisma from '../config/db';
import { AppError } from '../lib/errors';
import { hashPassword } from '../lib/password';
import {
  adminVendorInclude,
  platformUserSelect,
  toAdminVendor,
  toPlatformUser,
} from '../lib/serializers';
import type { AuthRequest } from '../middleware/authMiddleware';
import type {
  AdminResetPasswordInput,
  AdminUserStatusInput,
} from '../validation/admin';

const VENDOR_STATUSES = ['pending', 'verified', 'rejected', 'suspended'] as const;
const USER_ROLES = ['farmer', 'vendor', 'expert', 'admin'] as const;
const USER_STATUSES = ['active', 'pending', 'suspended', 'removed'] as const;

function stringParam(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function actor(req: AuthRequest) {
  if (!req.user) throw new AppError(401, 'unauthenticated', 'Authentication required');
  return req.user;
}

function targetId(req: Request): string {
  return String(req.params.id);
}

async function findVendorOrThrow(id: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { id },
    include: adminVendorInclude,
  });
  if (!vendor) throw new AppError(404, 'not_found', 'Vendor not found');
  return vendor;
}

export const listVendors = async (req: Request, res: Response): Promise<void> => {
  const status = stringParam(req.query.status);
  if (status && !VENDOR_STATUSES.includes(status as (typeof VENDOR_STATUSES)[number])) {
    throw new AppError(400, 'validation_error', 'Unknown vendor status');
  }

  const vendors = await prisma.vendor.findMany({
    where: status ? { verificationStatus: status.toUpperCase() } : {},
    include: adminVendorInclude,
    take: 200,
  });

  // Newest applications first. Sorting in memory avoids relying on relation
  // ordering support, which differs between Prisma versions.
  vendors.sort((a, b) => b.user.createdAt.getTime() - a.user.createdAt.getTime());

  res.status(200).json({
    success: true,
    vendors: vendors.map((vendor) => toAdminVendor(vendor)),
  });
};

export const verifyVendor = async (req: AuthRequest, res: Response): Promise<void> => {
  const admin = actor(req);
  const id = targetId(req);
  const vendor = await findVendorOrThrow(id);

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.vendor.update({
      where: { id },
      data: { verificationStatus: 'VERIFIED' },
      include: adminVendorInclude,
    });

    await tx.user.update({
      where: { id: vendor.userId },
      data: { status: UserStatus.ACTIVE },
    });

    await tx.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: 'vendor.verify',
        targetType: 'vendor',
        targetId: id,
        message: `${admin.name} approved vendor ${vendor.shopName}`,
      },
    });

    return next;
  });

  res.status(200).json({ success: true, vendor: toAdminVendor(updated) });
};

export const rejectVendor = async (req: AuthRequest, res: Response): Promise<void> => {
  const admin = actor(req);
  const id = targetId(req);
  const { reason } = req.body as { reason: string };
  const vendor = await findVendorOrThrow(id);

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.vendor.update({
      where: { id },
      data: { verificationStatus: 'REJECTED' },
      include: adminVendorInclude,
    });

    await tx.user.update({
      where: { id: vendor.userId },
      data: { status: UserStatus.REMOVED, tokenVersion: { increment: 1 } },
    });
    await tx.refreshToken.updateMany({
      where: { userId: vendor.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: 'vendor.reject',
        targetType: 'vendor',
        targetId: id,
        reason,
        message: `${admin.name} rejected vendor ${vendor.shopName}: ${reason}`,
      },
    });

    return next;
  });

  res.status(200).json({ success: true, vendor: toAdminVendor(updated, reason) });
};

export const suspendVendor = async (req: AuthRequest, res: Response): Promise<void> => {
  const admin = actor(req);
  const id = targetId(req);
  const { reason } = req.body as { reason: string };
  const vendor = await findVendorOrThrow(id);

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.vendor.update({
      where: { id },
      data: { verificationStatus: 'SUSPENDED' },
      include: adminVendorInclude,
    });

    await tx.user.update({
      where: { id: vendor.userId },
      data: { status: UserStatus.SUSPENDED, tokenVersion: { increment: 1 } },
    });
    await tx.refreshToken.updateMany({
      where: { userId: vendor.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: 'vendor.suspend',
        targetType: 'vendor',
        targetId: id,
        reason,
        message: `${admin.name} suspended vendor ${vendor.shopName}: ${reason}`,
      },
    });

    return next;
  });

  res.status(200).json({ success: true, vendor: toAdminVendor(updated, reason) });
};

export const listUsers = async (req: Request, res: Response): Promise<void> => {
  const role = stringParam(req.query.role);
  const status = stringParam(req.query.status);
  const query = stringParam(req.query.query);

  if (role && !USER_ROLES.includes(role as (typeof USER_ROLES)[number])) {
    throw new AppError(400, 'validation_error', 'Unknown role');
  }
  if (status && !USER_STATUSES.includes(status as (typeof USER_STATUSES)[number])) {
    throw new AppError(400, 'validation_error', 'Unknown account status');
  }

  const where: Prisma.UserWhereInput = {};
  if (role) where.role = role.toUpperCase() as Role;
  if (status) where.status = status.toUpperCase() as UserStatus;
  if (query) {
    where.OR = [
      { name: { contains: query, mode: 'insensitive' } },
      { mobileNumber: { contains: query } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    select: platformUserSelect,
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  res.status(200).json({
    success: true,
    users: users.map((user) => toPlatformUser(user)),
  });
};

export const setUserStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  const admin = actor(req);
  const id = targetId(req);
  const { status, reason } = req.body as AdminUserStatusInput;

  if (id === admin.id) {
    throw new AppError(400, 'cannot_modify_self', 'You cannot change your own account status');
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true, status: true },
  });
  if (!target) throw new AppError(404, 'not_found', 'Account not found');

  if (target.role === Role.ADMIN && status !== 'active') {
    const otherActiveAdmins = await prisma.user.count({
      where: { role: Role.ADMIN, status: UserStatus.ACTIVE, id: { not: id } },
    });
    if (otherActiveAdmins === 0) {
      throw new AppError(400, 'last_admin', 'At least one active administrator must remain');
    }
  }

  const nextStatus = status.toUpperCase() as UserStatus;
  const revokeSessions = status === 'suspended' || status === 'removed';

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.user.update({
      where: { id },
      data: {
        status: nextStatus,
        ...(revokeSessions ? { tokenVersion: { increment: 1 } } : {}),
      },
      select: platformUserSelect,
    });

    if (revokeSessions) {
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    if (target.role === Role.VENDOR) {
      const verificationStatus =
        status === 'active'
          ? 'VERIFIED'
          : status === 'pending'
            ? 'PENDING'
            : status === 'removed'
              ? 'REJECTED'
              : 'SUSPENDED';
      await tx.vendor.updateMany({
        where: { userId: id },
        data: { verificationStatus },
      });
    } else if (target.role === Role.EXPERT) {
      await tx.expert.updateMany({
        where: { userId: id },
        data: { verified: status === 'active' },
      });
    }

    await tx.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: 'user.status',
        targetType: 'user',
        targetId: id,
        reason: reason ?? null,
        message: `${admin.name} set ${target.name} (${target.role.toLowerCase()}) to ${status}${
          reason ? `: ${reason}` : ''
        }`,
      },
    });

    return next;
  });

  res.status(200).json({
    success: true,
    user: toPlatformUser(updated, reason ?? null),
  });
};

export const listLogs = async (req: Request, res: Response): Promise<void> => {
  const type = stringParam(req.query.type);
  if (type && type !== 'audit') {
    // System, collection, voice and AI logs are separate work; returning an
    // empty audit list is truthful rather than inventing lines.
    res.status(200).json({ success: true, logs: [] });
    return;
  }

  const logs = await prisma.adminAuditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  res.status(200).json({
    success: true,
    logs: logs.map((entry) => ({
      id: entry.id,
      type: 'audit',
      message: entry.message,
      at: entry.createdAt.toISOString(),
    })),
  });
};

export const listProducts = async (req: Request, res: Response): Promise<void> => {
  const products = await prisma.product.findMany({
    include: { vendor: { include: { user: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  res.status(200).json({
    success: true,
    products: products.map((product) => ({
      id: product.id,
      name: product.name,
      shop_name: product.vendor.shopName,
      category: product.category,
      price: Math.round(product.price),
      stock: product.stockLevel,
      hidden: false,
    })),
  });
};

/**
 * Issues a one-time temporary password for an account.
 *
 * Only the hash is stored: the plaintext is returned exactly once so the admin
 * can hand it to the owner, and never appears in the database, the audit log or
 * the server output. Every existing session for that account is revoked, and
 * the action is recorded against the admin who performed it.
 */
export const resetUserPassword = async (req: AuthRequest, res: Response): Promise<void> => {
  const admin = actor(req);
  const id = targetId(req);
  const { reason } = req.body as AdminResetPasswordInput;

  if (id === admin.id) {
    throw new AppError(
      400,
      'cannot_modify_self',
      'Change your own password from your profile',
      undefined,
      'নিজের পাসওয়ার্ড বদলাতে প্রোফাইল স্ক্রিন ব্যবহার করুন।',
    );
  }

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true },
  });
  if (!target) throw new AppError(404, 'not_found', 'Account not found');

  // 16 characters with upper, lower, digit and symbol, so it satisfies the same
  // policy the app enforces on registration.
  const temporaryPassword = `Ag${crypto.randomBytes(9).toString('base64url')}9!`;
  const passwordHash = await hashPassword(temporaryPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
        tokenVersion: { increment: 1 },
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    await tx.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await tx.adminAuditLog.create({
      data: {
        actorId: admin.id,
        action: 'user.reset_password',
        targetType: 'user',
        targetId: id,
        reason: reason ?? null,
        message: `${admin.name} reset the password of ${target.name} (${target.role.toLowerCase()})${
          reason ? `: ${reason}` : ''
        }`,
      },
    });
  });

  res.status(200).json({ success: true, temporary_password: temporaryPassword });
};

export const overview = async (_req: Request, res: Response): Promise<void> => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

  const [gmv, orders30, activeUsers, newUsers7, pendingVendors, pendingUsers, vendors] =
    await Promise.all([
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: {
          orderDate: { gte: thirtyDaysAgo },
          status: { notIn: ['CANCELLED', 'REJECTED'] },
        },
      }),
      prisma.order.count({
        where: {
          orderDate: { gte: thirtyDaysAgo },
          status: { notIn: ['CANCELLED', 'REJECTED'] },
        },
      }),
      prisma.user.count({ where: { status: UserStatus.ACTIVE } }),
      prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.vendor.count({ where: { verificationStatus: 'PENDING' } }),
      prisma.user.count({ where: { status: UserStatus.PENDING } }),
      prisma.vendor.count(),
    ]);

  const week = await Promise.all(
    Array.from({ length: 7 }, async (_, index) => {
      const start = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - (6 - index),
      );
      const end = new Date(start.getTime() + 86_400_000);
      const total = await prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: {
          orderDate: { gte: start, lt: end },
          status: { notIn: ['CANCELLED', 'REJECTED'] },
        },
      });
      return {
        day: start.toISOString(),
        value: Math.round(total._sum.totalAmount ?? 0),
      };
    }),
  );

  res.status(200).json({
    success: true,
    overview: {
      gmv30: Math.round(gmv._sum.totalAmount ?? 0),
      commission30: 0,
      activeUsers,
      newUsers7,
      orders30,
      pendingApprovals: pendingVendors + pendingUsers,
      openIssues: 0,
      vendors,
      week,
    },
  });
};
