import crypto from 'crypto';
import { Algorithm, hash, verify } from '@node-rs/argon2';

// OWASP Password Storage Cheat Sheet baseline for Argon2id:
// 19 MiB memory, 2 iterations, 1 degree of parallelism.
const ARGON_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // A malformed hash is a failed comparison, never an authentication success.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spend the same hashing work when the account does not exist, so response
 * timing does not reveal whether a mobile number is registered.
 */
export async function burnPasswordComparison(password: string): Promise<void> {
  dummyHash ??= hashPassword(crypto.randomUUID());
  await verifyPassword(await dummyHash, password);
}
