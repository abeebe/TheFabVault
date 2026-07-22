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

// ─── Password generation (Phase D, #2177 — routes/users.ts) ────────────────
//
// Used when an admin creates a user or resets a password without supplying
// one explicitly. crypto.randomInt (NOT crypto.randomBytes(1)[0] % alphabet
// — that has modulo bias whenever alphabet.length doesn't evenly divide
// 256) gives an unbiased pick per character; Node core implements
// randomInt's rejection sampling internally, so this needs no extra
// dependency. Alphabet excludes visually-ambiguous characters (0/O, 1/l/I)
// since this is a password a human may need to read off a screen and type
// once, and includes a handful of symbols for entropy without going full
// print-ASCII (some legacy systems choke on certain punctuation — kept
// conservative). 20 chars over this 67-symbol alphabet is ~121 bits of
// entropy (log2(67) * 20 ≈ 121.3), comfortably above any reasonable
// brute-force floor.
//
// Never logged and never persisted in plaintext anywhere — callers hash it
// with hashPassword() immediately and surface the plaintext to the admin
// exactly once, in the create/reset HTTP response body, same as any other
// generated-secret-shown-once UX.
const GENERATED_PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_';
const GENERATED_PASSWORD_LENGTH = 20;

export function generatePassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += GENERATED_PASSWORD_ALPHABET[crypto.randomInt(GENERATED_PASSWORD_ALPHABET.length)];
  }
  return out;
}

// Minimum length enforced on any admin-*supplied* password (create or
// reset-password with an explicit `password` field) — generatePassword()'s
// own output is always well above this, so the check only ever bites a
// human-typed value.
export const MIN_PASSWORD_LENGTH = 8;
