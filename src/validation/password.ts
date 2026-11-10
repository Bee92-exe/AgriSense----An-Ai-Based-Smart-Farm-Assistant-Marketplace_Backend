import { z } from 'zod';

/** Password policy shared by registration, reset and password changes. */
export const PASSWORD_MIN_LENGTH = 8;

const COMMON_PASSWORDS = new Set([
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

export interface PasswordContext {
  name?: string;
  mobile?: string;
}

/** Returns the first policy problem, or null when the password is acceptable. */
export function passwordProblem(password: string, context: PasswordContext = {}): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (password.length > 128) return 'Password must be at most 128 characters';

  if (!/[A-Za-z]/.test(password)) {
    return 'Password must include at least one letter';
  }
  if (!/\d/.test(password)) {
    return 'Password must include at least one number';
  }

  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    return 'That password is too common. Choose something unique';
  }

  if (context.mobile) {
    const national = context.mobile.slice(-10);
    if (lowered.includes(national) || lowered.includes(`0${national}`)) {
      return 'Password must not contain your mobile number';
    }
  }

  if (context.name) {
    const name = context.name.trim().toLowerCase();
    if (name.length >= 3 && lowered.includes(name)) {
      return 'Password must not contain your name';
    }
  }

  return null;
}

export const passwordSchema = (context: PasswordContext = {}) =>
  // The callback keeps the message close to the policy while allowing the
  // caller to supply the name/mobile that must not appear in the password.
  z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(128, 'Password must be at most 128 characters')
    .superRefine((value: string, ctx: any) => {
      const problem = passwordProblem(value, context);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    });