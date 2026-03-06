import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requireAdmin } from '../auth.js';
import { getDb } from '../db.js';
import { config } from '../config.js';
import { getStorageBreakdown, formatBytes } from '../services/storageStats.js';
import { assetFilePath, thumbExists } from '../services/fileStore.js';
import type { AssetRow } from '../types/index.js';

function assetRowToBasic(row: AssetRow) {
  const thumbStatus = row.thumb_status === 'done' && !thumbExists(row.id)
    ? 'failed' : row.thumb_status;
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.original_name ?? null,
    size: row.size,
    createdAt: row.created_at,
    folderId: row.folder_id ?? null,
    tags: JSON.parse(row.tags_json || '[]') as string[],
    thumbUrl: thumbStatus === 'done' ? `/thumb/${row.id}.jpg` : null,
  };
}

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

// ─── GET /admin/duplicates ────────────────────────────────────────────────────
// Returns duplicate groups by filename and by content hash
router.get('/admin/duplicates', requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();

    // Groups sharing the same display name (case-insensitive, excluding trashed)
    const nameGroups = db.prepare(`
      SELECT LOWER(COALESCE(original_name, filename)) AS key, COUNT(*) AS cnt
      FROM assets WHERE deleted_at IS NULL
      GROUP BY key HAVING cnt > 1
      ORDER BY cnt DESC, key ASC
    `).all() as { key: string; cnt: number }[];

    const byName = nameGroups.map(({ key, cnt }) => {
      const rows = db.prepare(`
        SELECT * FROM assets
        WHERE deleted_at IS NULL AND LOWER(COALESCE(original_name, filename)) = ?
        ORDER BY created_at ASC
      `).all(key) as AssetRow[];
      return { key, count: cnt, assets: rows.map(assetRowToBasic) };
    });

    // Groups sharing the same SHA-256 hash (exact content dupes, excluding trashed)
    const hashGroups = db.prepare(`
      SELECT file_hash AS key, COUNT(*) AS cnt
      FROM assets WHERE file_hash IS NOT NULL AND deleted_at IS NULL
      GROUP BY file_hash HAVING cnt > 1
      ORDER BY cnt DESC
    `).all() as { key: string; cnt: number }[];

    const byHash = hashGroups.map(({ key, cnt }) => {
      const rows = db.prepare(`
        SELECT * FROM assets WHERE file_hash = ? AND deleted_at IS NULL ORDER BY created_at ASC
      `).all(key) as AssetRow[];
      return { key, count: cnt, assets: rows.map(assetRowToBasic) };
    });

    const { unhashedCount } = db.prepare(
      'SELECT COUNT(*) AS unhashedCount FROM assets WHERE file_hash IS NULL AND deleted_at IS NULL'
    ).get() as { unhashedCount: number };

    res.json({ byName, byHash, unhashedCount });
  } catch (err) {
    console.error('[admin] Error getting duplicates:', err);
    res.status(500).json({ error: 'Failed to get duplicates' });
  }
});

// ─── POST /admin/duplicates/rehash ────────────────────────────────────────────
// Hash any assets that are missing a file_hash (runs in background)
router.post('/admin/duplicates/rehash', requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const rows = db.prepare(
      'SELECT id, filename FROM assets WHERE file_hash IS NULL AND deleted_at IS NULL'
    ).all() as { id: string; filename: string }[];

    res.json({ ok: true, queued: rows.length });

    // Background — don't block the response
    setImmediate(async () => {
      let done = 0;
      for (const row of rows) {
        try {
          const filePath = assetFilePath(row.id, row.filename);
          if (fs.existsSync(filePath)) {
            const buf = fs.readFileSync(filePath);
            const hash = crypto.createHash('sha256').update(buf).digest('hex');
            db.prepare('UPDATE assets SET file_hash = ? WHERE id = ?').run(hash, row.id);
            done++;
          }
        } catch (err) {
          console.warn(`[admin] Rehash failed for ${row.id}:`, err);
        }
      }
      console.log(`[admin] Rehash complete: ${done}/${rows.length} assets hashed`);
    });
  } catch (err) {
    console.error('[admin] Error starting rehash:', err);
    res.status(500).json({ error: 'Failed to start rehash' });
  }
});

// ─── GET /admin/orphans ───────────────────────────────────────────────────────
// Find dead DB records (file missing on disk) and orphan storage dirs (no DB row)
router.get('/admin/orphans', requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const allAssets = db.prepare('SELECT id, filename FROM assets WHERE deleted_at IS NULL').all() as { id: string; filename: string }[];

    // Dead records: asset exists in DB but the physical file is missing
    const deadRecords = allAssets
      .filter((row) => !fs.existsSync(assetFilePath(row.id, row.filename)))
      .map((row) => ({ id: row.id, filename: row.filename }));

    // Orphan dirs: subdirectory in storage/ has no matching asset ID in DB
    const activeIds = new Set(allAssets.map((a) => a.id));
    const RESERVED = new Set(['thumbs']);
    const orphanDirs: string[] = [];
    try {
      for (const entry of fs.readdirSync(config.storageDir)) {
        if (RESERVED.has(entry)) continue;
        if (!activeIds.has(entry)) orphanDirs.push(entry);
      }
    } catch { /* storage dir may not exist yet */ }

    res.json({ deadRecords, orphanDirs });
  } catch (err) {
    console.error('[admin] Error scanning orphans:', err);
    res.status(500).json({ error: 'Failed to scan orphans' });
  }
});

// ─── POST /admin/orphans/clean ────────────────────────────────────────────────
// Remove dead DB records and/or orphan storage dirs
router.post('/admin/orphans/clean', requireAdmin, (req: Request, res: Response) => {
  try {
    const {
      deleteDeadRecords = true,
      deleteOrphanDirs = true,
    } = req.body as { deleteDeadRecords?: boolean; deleteOrphanDirs?: boolean };

    const db = getDb();
    let removedRecords = 0;
    let removedDirs = 0;

    if (deleteDeadRecords) {
      const rows = db.prepare('SELECT id, filename FROM assets WHERE deleted_at IS NULL').all() as { id: string; filename: string }[];
      for (const row of rows) {
        if (!fs.existsSync(assetFilePath(row.id, row.filename))) {
          db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
          removedRecords++;
        }
      }
    }

    if (deleteOrphanDirs) {
      const activeIds = new Set(
        (db.prepare('SELECT id FROM assets').all() as { id: string }[]).map((r) => r.id)
      );
      const RESERVED = new Set(['thumbs']);
      try {
        for (const entry of fs.readdirSync(config.storageDir)) {
          if (RESERVED.has(entry)) continue;
          if (!activeIds.has(entry)) {
            fs.rmSync(path.join(config.storageDir, entry), { recursive: true, force: true });
            removedDirs++;
          }
        }
      } catch { /* ok */ }
    }

    res.json({ ok: true, removedRecords, removedDirs });
  } catch (err) {
    console.error('[admin] Error cleaning orphans:', err);
    res.status(500).json({ error: 'Failed to clean orphans' });
  }
});

export default router;
