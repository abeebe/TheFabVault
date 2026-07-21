import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { adminExists, getDb, closeDb } from './db.js';
import { requireLoopback } from './internalAccess.js';
import authRouter from './routes/auth.js';
import assetsRouter from './routes/assets.js';
import foldersRouter from './routes/folders.js';
import thumbsRouter from './routes/thumbs.js';
import projectsRouter from './routes/projects.js';
import subAssembliesRouter from './routes/subAssemblies.js';
import manifestImportRouter from './routes/manifestImport.js';
import setsRouter from './routes/sets.js';
import adminRouter from './routes/admin.js';
import mountsRouter from './routes/mounts.js';
import { requeuePendingThumbs, setServerPort, shutdownBrowser } from './services/thumbGen.js';
import { assetFilePath } from './services/fileStore.js';
import { ensureMountPoints, remountAll } from './services/mountManager.js';
import { errorMiddleware } from './errorMiddleware.js';
import { installProcessGuards } from './processGuards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Installed before anything else runs (route registration, mount setup,
// DB init below all happen synchronously after this) so a rejection or
// throw during boot itself is logged instead of silently killing the
// process with no trace. See processGuards.ts for the unhandledRejection
// vs uncaughtException distinction — #2044.
installProcessGuards();

const app = express();

// Trust NPM's proxy address (and only NPM's) for X-Forwarded-For.
// Pinned here in the same change that closes backlog #2060 — that
// pairing is Vera's required coupling, not incidental; see the
// rate-limiter comment in routes/auth.ts for the full mechanism,
// including why the *exact* address string (never a bare `true`/`1`)
// keeps this safe even though docker-compose.production.yml still
// publishes the api container's port directly on the host. The other
// half of #2060 — the unauthenticated /internal/asset-raw disclosure —
// is closed immediately below by requireLoopback.
app.set('trust proxy', '10.10.5.16');

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

// Health check (for Docker healthcheck, no auth required).
// authRequired is always true — see routes/auth.ts's /health for the
// full rationale (kept here for API-shape parity; this handler wins
// over authRouter's duplicate since it's registered first).
app.get('/health', (_req, res) => {
  res.json({ ok: true, authRequired: true });
});

// Internal: serve raw asset files for the Puppeteer thumbnail renderer.
// Loopback-only, no token — requireLoopback (internalAccess.ts) enforces
// this by checking the raw TCP peer address, not just a comment; see
// backlog #2060 (Vera, HIGH) for why the old comment-only version was a
// real disclosure — the API port is published directly on the host by
// docker-compose.production.yml, so this route was reachable by anyone
// on the LAN with zero auth before this guard existed.
app.get('/internal/asset-raw/:id/:filename', requireLoopback, (req, res) => {
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
app.use('/', subAssembliesRouter);
app.use('/', manifestImportRouter);
app.use('/', setsRouter);
app.use('/', adminRouter);
app.use('/', mountsRouter);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error-handling middleware — MUST be mounted last, after every
// route and after the 404 handler above. Express recognizes it as an
// error handler by its 4-argument signature (err, req, res, next), not by
// position, but it only ever sees a request that reached here via
// next(err) — so registration order doesn't change what it catches, only
// convention. Backstop for #2044; see errorMiddleware.ts.
app.use(errorMiddleware);

// Start server
const server = app.listen(config.port, () => {
  console.log(`[api] TheFabricatorsVault API listening on port ${config.port}`);

  // Initialize DB (this also resolves/persists the JWT secret and runs
  // the one-time admin seed — see db.ts getDb()). Auth is now always
  // enforced; the only variable is whether an admin exists yet to log
  // in as. Never logs a username or any secret, only yes/no.
  const db = getDb();
  console.log(`[api] Auth: always enforced (admin configured: ${adminExists() ? 'yes' : 'no — set AUTH_USERNAME/AUTH_PASSWORD and restart to seed'})`);
  console.log(`[api] Storage: ${config.storageDir}`);

  // Set port for Puppeteer renderer URL
  setServerPort(config.port);

  // Re-queue any pending thumbnails from before shutdown
  requeuePendingThumbs();

  // Ensure /imports/1,2,3 mount point directories exist (Admin UI-managed
  // NFS/SMB "Network Mounts" feature — routes/mounts.ts,
  // services/mountManager.ts — used for the "library" storage-backend
  // role and general share mount/unmount. Unrelated to file loading: the
  // mount-scan auto-import subsystem that used to read from these paths
  // was removed 2026-07-12 (#2078) — see git history for
  // services/mountImport.ts if that's ever needed for reference).
  ensureMountPoints();

  // Re-mount any NFS/SMB shares configured via the admin UI
  remountAll(db).catch((err) => console.error('[api] remountAll error:', err));
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
