import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import type {
  ProjectRow, ProjectAssetRow, AssetRow,
  ProjectOut, ProjectDetailOut, ProjectAssetOut,
  PrinterSettings, LaserSettings, VinylSettings, ProjectOverrides,
} from '../types/index.js';
import { thumbExists } from '../services/fileStore.js';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function projectToOut(row: ProjectRow, assetCount: number): ProjectOut {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    folderId: row.folder_id,
    tags: JSON.parse(row.tags_json || '[]'),
    printerSettings: JSON.parse(row.printer_settings_json || '{}') as PrinterSettings,
    laserSettings: JSON.parse(row.laser_settings_json || '{}') as LaserSettings,
    vinylSettings: JSON.parse(row.vinyl_settings_json || '{}') as VinylSettings,
    assetCount,
    createdAt: row.created_at,
  };
}

function assetRowToOut(row: AssetRow): import('../types/index.js').AssetOut {
  const tags: string[] = JSON.parse(row.tags_json || '[]');
  const encodedName = encodeURIComponent(row.filename);
  let thumbStatus = row.thumb_status;
  if (thumbStatus === 'done' && !thumbExists(row.id)) thumbStatus = 'failed';
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.original_name,
    mime: row.mime,
    size: row.size,
    folderId: row.folder_id,
    tags,
    notes: row.notes,
    thumbStatus,
    thumbUrl: thumbStatus === 'done' ? `/thumb/${row.id}.jpg` : null,
    url: `/file/${row.id}/${encodedName}`,
    meta: JSON.parse(row.meta_json || '{}'),
    createdAt: row.created_at,
    category: row.category ?? null,
    deletedAt: row.deleted_at ?? null,
    rating: row.rating ?? null,
    isFavorite: Boolean(row.is_favorite),
  };
}

// ─── GET /projects ────────────────────────────────────────────────────────────

router.get('/projects', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];

  const counts = db
    .prepare('SELECT project_id, COUNT(*) as cnt FROM project_assets GROUP BY project_id')
    .all() as { project_id: string; cnt: number }[];
  const countMap = new Map(counts.map((c) => [c.project_id, c.cnt]));

  res.json(rows.map((r) => projectToOut(r, countMap.get(r.id) ?? 0)));
});

// ─── POST /projects ───────────────────────────────────────────────────────────

router.post('/projects', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const {
    name, description, folderId, tags,
    printerSettings, laserSettings, vinylSettings,
  } = req.body as {
    name?: string;
    description?: string;
    folderId?: string | null;
    tags?: string[];
    printerSettings?: PrinterSettings;
    laserSettings?: LaserSettings;
    vinylSettings?: VinylSettings;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO projects (id, name, description, folder_id, tags_json,
       printer_settings_json, laser_settings_json, vinyl_settings_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, name.trim(),
    description ?? null,
    folderId ?? null,
    JSON.stringify(tags ?? []),
    JSON.stringify(printerSettings ?? {}),
    JSON.stringify(laserSettings ?? {}),
    JSON.stringify(vinylSettings ?? {}),
  );

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow;
  res.status(201).json(projectToOut(row, 0));
});

// ─── GET /project/:id ─────────────────────────────────────────────────────────

router.get('/project/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const paRows = db.prepare(
    `SELECT pa.*, a.*
     FROM project_assets pa
     JOIN assets a ON a.id = pa.asset_id
     WHERE pa.project_id = ?
     ORDER BY pa.sort_order ASC, a.created_at DESC`
  ).all(row.id) as (AssetRow & { project_id: string; sort_order: number; overrides_json: string })[];

  const assets: ProjectAssetOut[] = paRows.map((r) => ({
    ...assetRowToOut(r),
    overrides: JSON.parse(r.overrides_json || '{}') as ProjectOverrides,
  }));

  const detail: ProjectDetailOut = {
    ...projectToOut(row, assets.length),
    assets,
  };

  res.json(detail);
});

// ─── PATCH /project/:id ───────────────────────────────────────────────────────

router.patch('/project/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as ProjectRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const {
    name, description, folderId, tags,
    printerSettings, laserSettings, vinylSettings,
  } = req.body as {
    name?: string;
    description?: string;
    folderId?: string | null;
    tags?: string[];
    printerSettings?: PrinterSettings;
    laserSettings?: LaserSettings;
    vinylSettings?: VinylSettings;
  };

  if (name !== undefined) db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name.trim(), row.id);
  if (description !== undefined) db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(description ?? null, row.id);
  if (folderId !== undefined) db.prepare('UPDATE projects SET folder_id = ? WHERE id = ?').run(folderId ?? null, row.id);
  if (tags !== undefined) db.prepare('UPDATE projects SET tags_json = ? WHERE id = ?').run(JSON.stringify(tags), row.id);
  if (printerSettings !== undefined) db.prepare('UPDATE projects SET printer_settings_json = ? WHERE id = ?').run(JSON.stringify(printerSettings), row.id);
  if (laserSettings !== undefined) db.prepare('UPDATE projects SET laser_settings_json = ? WHERE id = ?').run(JSON.stringify(laserSettings), row.id);
  if (vinylSettings !== undefined) db.prepare('UPDATE projects SET vinyl_settings_json = ? WHERE id = ?').run(JSON.stringify(vinylSettings), row.id);

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.id) as ProjectRow;
  const assetCount = (db.prepare('SELECT COUNT(*) as cnt FROM project_assets WHERE project_id = ?').get(row.id) as { cnt: number }).cnt;
  res.json(projectToOut(updated, assetCount));
});

// ─── DELETE /project/:id ──────────────────────────────────────────────────────

router.delete('/project/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// ─── POST /project/:id/assets ─────────────────────────────────────────────────

router.post('/project/:id/assets', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

  const { assetIds } = req.body as { assetIds?: string[] };
  if (!Array.isArray(assetIds) || assetIds.length === 0) {
    res.status(400).json({ error: 'assetIds array is required' });
    return;
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO project_assets (project_id, asset_id, sort_order, overrides_json)
     VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM project_assets WHERE project_id = ?), '{}')`
  );

  const insertAll = db.transaction((ids: string[]) => {
    for (const assetId of ids) {
      const asset = db.prepare('SELECT id FROM assets WHERE id = ?').get(assetId);
      if (asset) insert.run(req.params.id, assetId, req.params.id);
    }
  });

  insertAll(assetIds);
  res.status(204).send();
});

// ─── DELETE /project/:id/asset/:assetId ──────────────────────────────────────

router.delete('/project/:id/asset/:assetId', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM project_assets WHERE project_id = ? AND asset_id = ?')
    .run(req.params.id, req.params.assetId);
  res.status(204).send();
});

// ─── PATCH /project/:id/asset/:assetId/overrides ─────────────────────────────

router.patch('/project/:id/asset/:assetId/overrides', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const pa = db.prepare(
    'SELECT * FROM project_assets WHERE project_id = ? AND asset_id = ?'
  ).get(req.params.id, req.params.assetId) as ProjectAssetRow | undefined;

  if (!pa) { res.status(404).json({ error: 'Asset not in project' }); return; }

  const overrides = req.body as ProjectOverrides;
  db.prepare('UPDATE project_assets SET overrides_json = ? WHERE project_id = ? AND asset_id = ?')
    .run(JSON.stringify(overrides), req.params.id, req.params.assetId);

  res.status(204).send();
});

export default router;
