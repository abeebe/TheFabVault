import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getDb } from './db.js';
import { requireAuth } from './auth.js';
import authRouter from './routes/auth.js';
import assetsRouter from './routes/assets.js';
import foldersRouter from './routes/folders.js';
import thumbsRouter from './routes/thumbs.js';
import projectsRouter from './routes/projects.js';
import { requeuePendingThumbs, setServerPort } from './services/thumbGen.js';
import { scanMountImports } from './services/mountImport.js';

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

// Serve static assets for thumbnail renderer (Three.js etc.)
const staticDir = path.join(__dirname, 'static');
app.use('/static', express.static(staticDir));

// Serve Three.js from node_modules for the Puppeteer renderer
const threeDir = path.join(__dirname, '..', 'node_modules', 'three', 'build');
if (process.env.NODE_ENV !== 'production') {
  // In dev (tsx), __dirname is src/
  app.use('/static/three.min.js', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.min.js')));
} else {
  // In prod (compiled), dist/ is at root
  app.use('/static/three.min.js', express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build', 'three.min.js')));
}

// Routes
app.use('/', authRouter);
app.use('/', assetsRouter);
app.use('/', foldersRouter);
app.use('/', thumbsRouter);
app.use('/', projectsRouter);

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
  getDb();

  // Set port for Puppeteer renderer URL
  setServerPort(config.port);

  // Re-queue any pending thumbnails from before shutdown
  requeuePendingThumbs();

  // Auto-scan NAS mount on startup
  if (config.importMountPath && config.importMountOnStartup) {
    console.log(`[api] Starting mount import scan: ${config.importMountPath}`);
    scanMountImports().catch((err) => console.error('[api] Mount import error:', err));
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[api] SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
