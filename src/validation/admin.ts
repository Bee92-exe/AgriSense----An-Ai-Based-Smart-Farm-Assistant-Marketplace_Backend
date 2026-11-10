import { z } from 'zod';

export const reasonSchema = z.object({
  reason: z.string().trim().min(3, 'Give a short reason').max(500),
});

export const adminUserStatusSchema = z.object({
  status: z.enum(['active', 'pending', 'suspended', 'removed']),
  reason: z.string().trim().min(3).max(500).optional(),
});

export type AdminUserStatusInput = z.infer<typeof adminUserStatusSchema>;

/// The reason is optional: a reset is a routine support action, not a decision
/// that has to be justified. When given, it is written to the audit log.
/// `preprocess` keeps an empty request body valid (express leaves it undefined).
export const adminResetPasswordSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    reason: z.string().trim().min(3).max(500).optional(),
  }),
);

export type AdminResetPasswordInput = z.infer<typeof adminResetPasswordSchema>;
