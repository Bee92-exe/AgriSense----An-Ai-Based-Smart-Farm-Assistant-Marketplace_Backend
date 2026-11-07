import { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors';

export const notFoundHandler = (_req: Request, res: Response): void => {
  res.status(404).json({ success: false, code: 'not_found', message: 'Route not found', message_bn: 'পৃষ্ঠা পাওয়া যায়নি' });
};


export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      message_bn: err.messageBn ?? null,
      ...(err.details === undefined ? {} : { details: err.details }),
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json({
      success: false,
      code: 'conflict',
      message: 'That record already exists',
      message_bn: 'এই তথ্য আগে থেকেই আছে',
    });
    return;
  }

  console.error('[error]', err instanceof Error ? err.message : 'Unknown error');
  res.status(500).json({
    success: false,
    code: 'internal_error',
    message: 'Internal server error',
    message_bn: 'সার্ভারে সমস্যা হয়েছে। পরে আবার চেষ্টা করুন।',
  });
};
