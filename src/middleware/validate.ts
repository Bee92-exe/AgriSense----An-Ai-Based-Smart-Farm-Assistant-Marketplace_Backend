import { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../lib/errors';

/** Parses and normalises the body, replacing it with validated data only. */
export const validateBody =
  (schema: z.ZodType) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(
        new AppError(
          400,
          'validation_error',
          'Please check the highlighted fields',
          result.error.issues.map((issue) => ({
            field: issue.path.join('.') || 'body',
            message: issue.message,
          })),
          'তথ্যগুলো আবার দেখুন — কিছু ঘরে সমস্যা আছে।',
        ),
      );
      return;
    }

    req.body = result.data;
    next();
  };
