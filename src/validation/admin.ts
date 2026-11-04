import { z } from 'zod';

export const reasonSchema = z.object({
  reason: z.string().trim().min(3, 'Give a short reason').max(500),
});

export const adminUserStatusSchema = z.object({
  status: z.enum(['active', 'pending', 'suspended', 'removed']),
  reason: z.string().trim().min(3).max(500).optional(),
});

export type AdminUserStatusInput = z.infer<typeof adminUserStatusSchema>;
