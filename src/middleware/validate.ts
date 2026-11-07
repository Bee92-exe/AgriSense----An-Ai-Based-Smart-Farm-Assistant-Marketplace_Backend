import { NextFunction, Request, Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../lib/errors';

const FIELD_BANGLA: Record<string, string> = {
  name: 'নামটি ঠিক করুন।',
  mobile: 'সঠিক মোবাইল নম্বর দিন।',
  password: 'পাসওয়ার্ডের নিয়ম পূরণ করুন।',
  newPassword: 'নতুন পাসওয়ার্ডের নিয়ম পূরণ করুন।',
  district: 'জেলা নির্বাচন করুন।',
  role: 'ভূমিকা নির্বাচন করুন।',
  shop_name: 'দোকানের নাম লিখুন।',
  license_no: 'ট্রেড লাইসেন্স নম্বর লিখুন।',
  specialization: 'বিশেষজ্ঞতার ক্ষেত্র লিখুন।',
  certification: 'সনদ বা যোগ্যতার তথ্য লিখুন।',
  body: 'তথ্যগুলো আবার দেখুন।',
};

function validationMessageBn(field: string, message: string): string {
  const lower = message.toLowerCase();
  if (field === 'password' || field === 'newPassword') {
    if (lower.includes('mobile number')) return 'পাসওয়ার্ডে নিজের মোবাইল নম্বর ব্যবহার করা যাবে না।';
    if (lower.includes('your name')) return 'পাসওয়ার্ডে নিজের নাম ব্যবহার করা যাবে না।';
    if (lower.includes('too common')) return 'পাসওয়ার্ডটি খুব সাধারণ। অন্য একটি পাসওয়ার্ড বেছে নিন।';
    if (lower.includes('at least one letter')) return 'পাসওয়ার্ডে অন্তত একটি অক্ষর দিন।';
    if (lower.includes('at least one number')) return 'পাসওয়ার্ডে অন্তত একটি সংখ্যা দিন।';
    if (lower.includes('at least 8')) return 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে।';
    if (lower.includes('different')) return 'নতুন পাসওয়ার্ড আগেরটির থেকে আলাদা হতে হবে।';
    return FIELD_BANGLA[field]!;
  }
  return FIELD_BANGLA[field] ?? FIELD_BANGLA.body!;
}

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
            message_bn: validationMessageBn(issue.path.join('.') || 'body', issue.message),
          })),
          'তথ্যগুলো আবার দেখুন — কিছু ঘরে সমস্যা আছে।',
        ),
      );
      return;
    }

    req.body = result.data;
    next();
  };
