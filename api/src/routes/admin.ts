import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAdmin } from '../auth.js';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { getStorageBreakdown, formatBytes } from '../services/storageStats.js';

const router = Router();

// GET /admin/config - Get current configuration and storage stats
router.get('/admin/config', requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const breakdown = getStorageBreakdown();

    // Get storage path from system_config or use current config
    const storagePath = config.storageDir;

    res.json({
      storagePath,
      storagePathDisplay: path.resolve(storagePath),
      dataDirPath: path.resolve(config.dataDir),
      storage: {
        total: breakdown.total,
        totalFormatted: formatBytes(breakdown.total),
        assets: breakdown.assets,
        assetsFormatted: formatBytes(breakdown.assets),
        thumbnails: breakdown.thumbnails,
        thumbnailsFormatted: formatBytes(breakdown.thumbnails),
        assetCount: breakdown.assetCount,
      },
      config: {
        maxUploadMb: config.importMaxMb,
        authEnabled: config.authEnabled,
        corsOrigins: config.corsOrigins,
      },
    });
  } catch (err) {
    console.error('[admin] Error getting config:', err);
    res.status(500).json({ error: 'Failed to get configuration' });
  }
});

// POST /admin/config/storage - Update storage path
router.post('/admin/config/storage', requireAdmin, (req: Request, res: Response) => {
  try {
    const { newPath } = req.body as { newPath?: string };

    if (!newPath || typeof newPath !== 'string') {
      res.status(400).json({ error: 'newPath is required and must be a string' });
      return;
    }

    const normalizedPath = path.resolve(newPath);

    // Validate path
    if (!fs.existsSync(normalizedPath)) {
      res.status(400).json({ error: `Path does not exist: ${normalizedPath}` });
      return;
    }

    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: `Path is not a directory: ${normalizedPath}` });
      return;
    }

    // Check if we can write to this directory
    try {
      const testFile = path.join(normalizedPath, '.thefabvault-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
    } catch {
      res.status(400).json({ error: `Cannot write to directory: ${normalizedPath}` });
      return;
    }

    // Update system_config in database
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)')
      .run('storageDir', normalizedPath);

    res.json({
      success: true,
      message: 'Storage path updated. Application restart required.',
      newPath: normalizedPath,
    });
  } catch (err) {
    console.error('[admin] Error updating storage path:', err);
    res.status(500).json({ error: 'Failed to update storage path' });
  }
});

// POST /admin/restart - Signal application to restart
router.post('/admin/restart', requireAdmin, (_req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      message: 'Restart signal sent. Application will restart shortly.',
    });

    // Send SIGTERM to self after brief delay to allow response to be sent
    setTimeout(() => {
      console.log('[admin] Shutting down for restart...');
      process.kill(process.pid, 'SIGTERM');
    }, 100);
  } catch (err) {
    console.error('[admin] Error sending restart signal:', err);
    res.status(500).json({ error: 'Failed to send restart signal' });
  }
});

export default router;
