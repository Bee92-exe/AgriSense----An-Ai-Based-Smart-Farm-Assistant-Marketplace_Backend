import { Request, Response } from 'express';
import prisma from '../config/db';
import { AppError } from '../lib/errors';
import { publicUserSelect, toPublicUser } from '../lib/serializers';
import { AuthRequest } from '../middleware/authMiddleware';

export const getMyProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: publicUserSelect,
  });

  if (!user) throw new AppError(404, 'not_found', 'User not found');

  res.status(200).json({ success: true, user: toPublicUser(user) });
};

export const updateMyProfile = async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'unauthenticated', 'Authentication required');

  const { name, district, farmSize, businessName, specialization } = req.body;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, 'not_found', 'User not found');

  const updatedUser = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(district !== undefined ? { location: district } : {}),
      },
    });

    if (user.role === 'FARMER' && farmSize !== undefined) {
      await tx.farmer.update({
        where: { userId },
        data: { landSize: parseFloat(farmSize) },
      });
    } else if (user.role === 'VENDOR' && businessName !== undefined) {
      await tx.vendor.update({
        where: { userId },
        data: { shopName: businessName },
      });
    } else if (user.role === 'EXPERT' && specialization !== undefined) {
      await tx.expert.update({
        where: { userId },
        data: { specialization },
      });
    }

    return tx.user.findUnique({ where: { id: userId }, select: publicUserSelect });
  });

  if (!updatedUser) throw new AppError(404, 'not_found', 'User not found');

  res.status(200).json({
    success: true,
    message: 'Profile updated successfully',
    user: toPublicUser(updatedUser),
  });
};
