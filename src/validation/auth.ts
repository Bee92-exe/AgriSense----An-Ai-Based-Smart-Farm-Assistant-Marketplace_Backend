import { z } from 'zod';
import { normalizeMobile } from '../lib/phone';

const mobile = z
  .string()
  .trim()
  .min(1, 'Mobile number is required')
  .transform((value, ctx) => {
    const normalized = normalizeMobile(value);
    if (!normalized) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter a valid Bangladeshi mobile number (for example 01712345678)',
      });
      return z.NEVER;
    }
    return normalized;
  });

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters');

const commonPasswords = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty123',
  'letmein',
  'iloveyou',
  'welcome1',
  'admin123',
  'abc12345',
  '11111111',
  '00000000',
  'bangladesh',
  'agrisense',
  'farmer123',
  'vendor123',
  'expert123',
]);

export const registerSchema = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
    mobile,
    password,
    // ADMIN is deliberately absent: administrator accounts are provisioned by
    // promotion, never through public registration.
    role: z.enum(['farmer', 'vendor', 'expert']),
    district: z.string().trim().min(1, 'District is required').max(120),
    farm_size: z.coerce.number().positive('Farm size must be greater than zero').max(10_000).optional(),
    shop_name: z.string().trim().max(160).optional(),
    license_no: z.string().trim().max(160).optional(),
    specialization: z.string().trim().max(120).optional(),
    certification: z.string().trim().max(160).optional(),
  })
  .superRefine((data, ctx) => {
    const lowered = data.password.toLowerCase();
    const national = data.mobile.slice(-10);

    if (lowered.includes(national) || lowered.includes(`0${national}`)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password must not contain your mobile number',
      });
    }

    const name = data.name.trim().toLowerCase();
    if (name.length >= 3 && lowered.includes(name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password must not contain your name',
      });
    }

    if (commonPasswords.has(lowered)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'That password is too common. Choose something unique',
      });
    }

    if (/^\d+$/.test(data.password)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: 'Password must not be only numbers. Mix letters and numbers',
      });
    }
  });

export const loginSchema = z.object({
  mobile,
  // Deliberately not the policy schema: an old password must still be accepted
  // (and hashed-compared) rather than rejected at the boundary as malformed.
  password: z.string().min(1, 'Password is required').max(128),
});

export const refreshSchema = z.object({
  refresh: z.string().min(20, 'Refresh token is required').max(200),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(128),
    newPassword: password,
  })
  .superRefine((data, ctx) => {
    if (data.currentPassword === data.newPassword) {
      ctx.addIssue({
        code: 'custom',
        path: ['newPassword'],
        message: 'New password must be different from the current one',
      });
    }

    if (/^\d+$/.test(data.newPassword)) {
      ctx.addIssue({
        code: 'custom',
        path: ['newPassword'],
        message: 'Password must not be only numbers. Mix letters and numbers',
      });
    }
  });

export const forgotPasswordSchema = z.object({ mobile });

export const resetPasswordSchema = z.object({
  token: z.string().min(32, 'Reset code is required').max(200),
  newPassword: password,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
