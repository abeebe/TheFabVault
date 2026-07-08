// Password hashing for the admin `users` table (migration v13).
//
// Uses Node's builtin crypto.scrypt (no new dependency). Deliberately
// avoiding bcrypt/argon2 — both are native-compiled and this Dockerfile
// already carries visible scar tissue from better-sqlite3 + Puppeteer/
// Chromium multi-arch pain (see Dockerfile comments). scrypt has been in
// Node core since v10 and needs nothing extra to build on any arch.
//
// Stored as a self-describing string so the work factor can change later
// without a schema migration: scrypt:<N>:<r>:<p>:<saltHex>:<hashHex>

import crypto from 'crypto';

const SCRYPT_N = 16384; // 2^14 — Node's own documented default
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derivedKey = crypto.scryptSync(password, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored `scrypt:...` hash string.
 *
 * Fails closed: any malformed/unrecognized stored value, or any error
 * thrown while deriving the comparison key, returns false (no match) —
 * never throws out to the caller, and never treats "couldn't parse the
 * stored hash" as "let them in."
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split(':');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
    const N = parseInt(nStr, 10);
    const r = parseInt(rStr, 10);
    const p = parseInt(pStr, 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = crypto.scryptSync(password, salt, expected.length, { N, r, p });
    if (actual.length !== expected.length) return false;

    // Constant-time compare — never use === on derived key bytes.
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
