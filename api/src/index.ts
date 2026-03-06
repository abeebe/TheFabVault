import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getDb, closeDb } from './db.js';
import { requireAuth } from './auth.js';
import authRouter from './routes/auth.js';
import assetsRouter from './routes/assets.js';
import foldersRouter from './routes/folders.js';
import thumbsRouter from './routes/thumbs.js';
import projectsRouter from './routes/projects.js';
import adminRouter from './routes/admin.js';
import mountsRouter from './routes/mounts.js';
import { requeuePendingThumbs, setServerPort, shutdownBrowser } from './services/thumbGen.js';
import { scanMountImports } from './services/mountImport.js';
import { assetFilePath } from './services/fileStore.js';
import { ensureMountPoints, remountAll } from './services/mountManager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// CORS
app.use(cors({
  origin: config.corsOrigins,
  credentials: true,
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets for thumbnail renderer (Three.js, thumb-renderer.html, etc.)
const staticDir = path.join(__dirname, 'static');
app.use('/static', express.static(staticDir));

// Health check (for Docker healthcheck, no auth required)
app.get('/health', (_req, res) => {
  res.json({ ok: true, authRequired: config.authEnabled });
});

// Internal: serve raw asset files for the Puppeteer thumbnail renderer.
// Localhost-only, no auth — only the renderer page on the same host uses this.
app.get('/internal/asset-raw/:id/:filename', (req, res) => {
  const filePath = assetFilePath(req.params.id, req.params.filename);
  res.sendFile(filePath, (err: any) => {
    if (err && !res.headersSent) {
      res.status(404).json({ error: 'File not found' });
    }
  });
});

// Routes
app.use('/', authRouter);
app.use('/', assetsRouter);
app.use('/', foldersRouter);
app.use('/', thumbsRouter);
app.use('/', projectsRouter);
app.use('/', adminRouter);
app.use('/', mountsRouter);

// Import scan endpoint
app.post('/import/scan', requireAuth, async (_req, res) => {
  try {
    const result = await scanMountImports();
    res.json(result);
  } catch (err) {
    console.error('[import/scan]', err);
    res.status(500).json({ error: 'Scan failed' });
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
const server = app.listen(config.port, () => {
  console.log(`[api] TheFabricatorsVault API listening on port ${config.port}`);
  console.log(`[api] Auth: ${config.authEnabled ? 'enabled' : 'DISABLED'}`);
  console.log(`[api] Storage: ${config.storageDir}`);

  // Initialize DB
  const db = getDb();

  // Set port for Puppeteer renderer URL
  setServerPort(config.port);

  // Re-queue any pending thumbnails from before shutdown
  requeuePendingThumbs();

  // Ensure /imports/1,2,3 mount point directories exist
  ensureMountPoints();

  // Re-mount any NFS/SMB shares configured via the admin UI
  remountAll(db).then(() => {
    // Auto-scan mount points on startup (after shares are mounted)
    if (config.importMountOnStartup) {
      const paths = config.importMountPaths;
      if (paths.length) {
        console.log(`[api] Starting mount import scan: ${paths.join(', ')}`);
        scanMountImports().catch((err) => console.error('[api] Mount import error:', err));
      }
    }
  }).catch((err) => console.error('[api] remountAll error:', err));
});

// Graceful shutdown
async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} received, shutting down gracefully`);
  server.close(async () => {
    try {
      await shutdownBrowser();
      closeDb();
      console.log('[api] Cleanup complete, exiting');
    } catch (err) {
      console.error('[api] Error during cleanup:', err);
    }
    process.exit(0);
  });
  // Force exit after 10s if graceful shutdown stalls
  setTimeout(() => {
    console.error('[api] Forced exit after timeout');
    closeDb();
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
