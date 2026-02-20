export const config = {
  port: parseInt(process.env.PORT ?? '3000', 10),
  jwtSecret: process.env.JWT_SECRET ?? 'changeme-replace-in-production',
  jwtTtl: parseInt(process.env.JWT_TTL ?? '43200', 10),
  authUsername: process.env.AUTH_USERNAME ?? '',
  authPassword: process.env.AUTH_PASSWORD ?? '',
  get authEnabled() {
    return !!(this.authUsername && this.authPassword);
  },
  storageDir: process.env.STORAGE_DIR ?? './data/storage',
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
