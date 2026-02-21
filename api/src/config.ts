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

export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  jwtSecret: process.env.JWT_SECRET ?? 'changeme-replace-in-production',
  jwtTtl: parseInt(process.env.JWT_TTL ?? '43200', 10),
  authUsername: process.env.AUTH_USERNAME ?? '',
  authPassword: process.env.AUTH_PASSWORD ?? '',
  get authEnabled() {
    return !!(this.authUsername && this.authPassword);
  },
  get storageDir() {
    return getStorageDir();
  },
  dataDir: process.env.DATA_DIR ?? './data/db',
  importMountPath: process.env.IMPORT_MOUNT_PATH ?? '',
  importMountOnStartup: process.env.IMPORT_MOUNT_ON_STARTUP !== 'false',
  importMountExts: process.env.IMPORT_MOUNT_EXTS ?? '',
  importMaxMb: parseInt(process.env.IMPORT_MAX_MB ?? '512', 10),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};
