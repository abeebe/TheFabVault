// Helper to get storageDir from DB or env var
function getStorageDir(): string {
  // Try to get from DB first (if it's initialized)
  try {
    // Import here to avoid circular dependency
    const { getDb } = require('./db.js') as { getDb: () => any };
    const db = getDb();
    const result = db
      .prepare('SELECT value FROM system_config WHERE key = ?')
      .get('storageDir') as { value: string } | undefined;
    if (result?.value) {
      return result.value;
    }
  } catch {
    // DB not initialized yet, fall through to env var
  }
  // Fall back to env var
  return process.env.STORAGE_DIR ?? './data/storage';
}

// NPM's exact proxy address, trusted for X-Forwarded-For resolution
// (index.ts's `app.set('trust proxy', TRUSTED_PROXY_ADDR)`). Pulled out
// into a named, exported constant (#2075) rather than left as a bare
// string literal inline at the app.set() call so
// __tests__/trustProxy.test.ts's regression suite imports the exact
// same value index.ts configures — a literal-string copy in the test
// file could silently drift from index.ts's if the trusted address is
// ever changed (an NPM migration, a new hop) without anyone noticing
// the test no longer proves anything about the real config. See the
// exact-match rationale at the app.set() call site in index.ts and at
// the login rate limiter in routes/auth.ts.
export const TRUSTED_PROXY_ADDR = '10.10.5.16';

// Auth (username/password/JWT secret) intentionally does NOT live here.
// AUTH_USERNAME/AUTH_PASSWORD are read directly (once, at boot) only by
// db.ts's one-time seed function — they are bootstrap input, not ongoing
// config. The JWT secret is DB-persisted and resolved via db.ts's
// getJwtSecret(); there is no literal-string fallback anywhere (that was
// the 'changeme-replace-in-production' hardcoded secret this migration
// removes — see Reports/vera-fabvault-auth-migration-security-review-2026-07-08.md,
// "Hardcoded fallback JWT signing secret"). Keeping auth resolution out of
// this plain config object on purpose: it removes the shape that let
// `config.authEnabled` become a silent fail-open switch. Auth is now
// always enforced by requireAuth/requireAdmin (api/src/auth.ts) checking
// a live `users` row — there's no boolean gate here to short-circuit.
export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  jwtTtl: parseInt(process.env.JWT_TTL ?? '43200', 10),
  get storageDir() {
    return getStorageDir();
  },
  dataDir: process.env.DATA_DIR ?? './data/db',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
