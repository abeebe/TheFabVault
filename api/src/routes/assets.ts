import { Router, Request, Response } from 'express';
import multer from 'multer';
import archiver from 'archiver';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import {
  assetFilePath,
  assetDir,
  cleanupAsset,
  thumbExists,
  thumbFilePath,
  sanitizeFilename,
} from '../services/fileStore.js';
import { enqueueThumb } from '../services/thumbGen.js';
import { extractMeta } from '../services/metaExtract.js';
import type { AssetOut, AssetRow, FolderRow } from '../types/index.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

const THUMB_ELIGIBLE_EXTS = new Set([
  '.stl', '.obj', '.3mf',
  '.svg', '.dxf',
  '.png', '.jpg', '.jpeg', '.webp',
  '.gcode', '.gc', '.g',
]);

function needsThumbnail(filename: string): boolean {
  return THUMB_ELIGIBLE_EXTS.has(path.extname(filename).toLowerCase());
}

function toOut(row: AssetRow): AssetOut {
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
  };
}

async function saveUploadedFile(
  buffer: Buffer,
  assetId: string,
  filename: string,
  mimeType: string,
  folderId: string | null,
  tags: string[],
  notes: string | null,
  originalName: string | null,
  sourcePath: string | null = null,
): Promise<AssetRow> {
  const db = getDb();

  db.prepare(
    `INSERT INTO assets (id, filename, original_name, mime, size, folder_id, tags_json, notes, source_path, thumb_status, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    assetId, filename, originalName, mimeType, buffer.length,
    folderId ?? null, JSON.stringify(tags), notes ?? null, sourcePath,
    needsThumbnail(filename) ? 'pending' : 'none', '{}',
  );

  const dest = assetFilePath(assetId, filename);
  fs.writeFileSync(dest, buffer);

  const size = fs.statSync(dest).size;
  db.prepare('UPDATE assets SET size = ? WHERE id = ?').run(size, assetId);

  try {
    const meta = await extractMeta(dest);
    db.prepare('UPDATE assets SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), assetId);
  } catch (err) {
    console.warn(`[assets] Meta extraction failed for ${assetId}:`, err);
  }

  return db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow;
}

// ─── POST /upload ─────────────────────────────────────────────────────────────

router.post('/upload', requireAuth, upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }

  const originalName = req.file.originalname || 'upload';
  const filename = sanitizeFilename(originalName);
  const mimeType = req.file.mimetype || mime.lookup(filename) || 'application/octet-stream';
  const folderId = (req.body.folder_id as string | undefined) ?? null;
  const tags = (req.body.tags as string | undefined)
    ? (req.body.tags as string).split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const notes = (req.body.notes as string | undefined) ?? null;

  const id = uuidv4();
  const row = await saveUploadedFile(req.file.buffer, id, filename, mimeType, folderId, tags, notes, originalName);

  if (needsThumbnail(filename)) enqueueThumb(id);

  res.status(201).json(toOut(row));
});

// ─── POST /upload/batch ───────────────────────────────────────────────────────

router.post('/upload/batch', requireAuth, upload.array('files'), async (req: Request, res: Response) => {
  const files = req.files as Express.Multer.File[] | undefined;
  if (!files || files.length === 0) { res.status(400).json({ error: 'No files provided' }); return; }

  const folderId = (req.body.folder_id as string | undefined) ?? null;
  const results: AssetOut[] = [];

  for (const file of files) {
    const originalName = file.originalname || 'upload';
    const filename = sanitizeFilename(originalName);
    const mimeType = file.mimetype || mime.lookup(filename) || 'application/octet-stream';
    const id = uuidv4();
    const row = await saveUploadedFile(file.buffer, id, filename, mimeType, folderId, [], null, originalName);
    if (needsThumbnail(filename)) enqueueThumb(id);
    results.push(toOut(row));
  }

  res.status(201).json(results);
});

// ─── GET /assets ──────────────────────────────────────────────────────────────

const SORT_MAP: Record<string, string> = {
  date_desc: 'created_at DESC',
  date_asc:  'created_at ASC',
  name_asc:  'LOWER(COALESCE(original_name, filename)) ASC',
  name_desc: 'LOWER(COALESCE(original_name, filename)) DESC',
};

router.get('/assets', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const { q, tags: tagsParam, folder_id, limit = '100', offset = '0', sort = 'date_desc' } = req.query as Record<string, string>;

  const orderBy = SORT_MAP[sort] ?? SORT_MAP['date_desc'];

  let whereClause = ' WHERE 1=1';
  const whereParams: unknown[] = [];

  if (q) {
    whereClause += ' AND (filename LIKE ? OR original_name LIKE ? OR notes LIKE ?)';
    const like = `%${q}%`;
    whereParams.push(like, like, like);
  }

  if (folder_id === 'none') {
    whereClause += ' AND folder_id IS NULL';
  } else if (folder_id) {
    whereClause += ' AND folder_id = ?';
    whereParams.push(folder_id);
  }

  // Total count (before pagination)
  const total = (db.prepare(`SELECT COUNT(*) as count FROM assets${whereClause}`).get(...whereParams) as { count: number }).count;

  const sql = `SELECT * FROM assets${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const params = [...whereParams, parseInt(limit, 10), parseInt(offset, 10)];

  let rows = db.prepare(sql).all(...params) as AssetRow[];

  if (tagsParam) {
    const filterTags = tagsParam.split(',').map((t) => t.trim()).filter(Boolean);
    rows = rows.filter((row) => {
      const assetTags: string[] = JSON.parse(row.tags_json || '[]');
      return filterTags.every((ft) => assetTags.includes(ft));
    });
  }

  res.json({ items: rows.map(toOut), total });
});

// ─── GET /asset/:id ───────────────────────────────────────────────────────────

router.get('/asset/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(toOut(row));
});

// ─── GET /file/:id/:name ──────────────────────────────────────────────────────

router.get('/file/:id/:name', requireAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) { res.status(400).json({ error: 'Invalid id' }); return; }
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const filePath = assetFilePath(id, row.filename);
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return; }
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${row.filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ─── POST /asset/:id/extract-meta ─────────────────────────────────────────────

router.post('/asset/:id/extract-meta', requireAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const filePath = assetFilePath(row.id, row.filename);
  if (!fs.existsSync(filePath)) { res.status(404).json({ error: 'File not found on disk' }); return; }

  try {
    const meta = await extractMeta(filePath);
    db.prepare('UPDATE assets SET meta_json = ? WHERE id = ?').run(JSON.stringify(meta), row.id);
    const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id) as AssetRow;
    res.json(toOut(updated));
  } catch (err) {
    console.error('[assets] extract-meta error:', err);
    res.status(500).json({ error: 'Extraction failed' });
  }
});

// ─── PATCH /asset/:id/meta ────────────────────────────────────────────────────

router.patch('/asset/:id/meta', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const { title, notes } = req.body as { title?: string; notes?: string };
  if (title !== undefined) db.prepare('UPDATE assets SET original_name = ? WHERE id = ?').run(title.trim(), row.id);
  if (notes !== undefined) db.prepare('UPDATE assets SET notes = ? WHERE id = ?').run(notes, row.id);

  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id) as AssetRow;
  res.json(toOut(updated));
});

// ─── PATCH /asset/:id/tags ────────────────────────────────────────────────────

router.patch('/asset/:id/tags', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const { tags } = req.body as { tags?: string[] };
  if (!Array.isArray(tags)) { res.status(400).json({ error: 'tags must be an array' }); return; }

  db.prepare('UPDATE assets SET tags_json = ? WHERE id = ?').run(JSON.stringify(tags), row.id);
  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id) as AssetRow;
  res.json(toOut(updated));
});

// ─── PATCH /asset/:id/rename ──────────────────────────────────────────────────

router.patch('/asset/:id/rename', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const { filename: newName } = req.body as { filename?: string };
  if (!newName?.trim()) { res.status(400).json({ error: 'filename is required' }); return; }

  const sanitized = sanitizeFilename(newName.trim());
  const oldExt = path.extname(row.filename).toLowerCase();
  const newExt = path.extname(sanitized).toLowerCase();
  const finalName = newExt ? sanitized : sanitized + oldExt;

  if (finalName === row.filename) { res.json(toOut(row)); return; }

  const oldPath = assetFilePath(row.id, row.filename);
  const newPath = assetFilePath(row.id, finalName);

  if (!fs.existsSync(oldPath)) { res.status(404).json({ error: 'File not found on disk' }); return; }
  if (fs.existsSync(newPath)) { res.status(409).json({ error: 'A file with that name already exists' }); return; }

  fs.renameSync(oldPath, newPath);
  db.prepare('UPDATE assets SET filename = ? WHERE id = ?').run(finalName, row.id);
  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id) as AssetRow;
  res.json(toOut(updated));
});

// ─── PATCH /asset/:id/folder ──────────────────────────────────────────────────

router.patch('/asset/:id/folder', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const { folder_id } = req.body as { folder_id?: string | null };
  const folderId = folder_id ?? null;

  if (folderId) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId);
    if (!folder) { res.status(400).json({ error: 'Folder not found' }); return; }
  }

  db.prepare('UPDATE assets SET folder_id = ? WHERE id = ?').run(folderId, row.id);
  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id) as AssetRow;
  res.json(toOut(updated));
});

// ─── DELETE /asset/:id ────────────────────────────────────────────────────────

router.delete('/asset/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  // delete_file defaults to true — pass ?delete_file=false to keep the file on disk
  const deleteFile = req.query.delete_file !== 'false';
  db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
  cleanupAsset(row.id, { deleteFile });
  res.json({ ok: true });
});

// ─── POST /asset/:id/rethumb — re-queue thumbnail generation for one asset ────

router.post('/asset/:id/rethumb', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const ext = path.extname(row.filename).toLowerCase();
  if (!needsThumbnail(row.filename)) {
    res.status(400).json({ error: 'File type does not support thumbnails' });
    return;
  }

  // Delete existing thumbnail file if present
  const tp = thumbFilePath(row.id);
  if (fs.existsSync(tp)) {
    try { fs.unlinkSync(tp); } catch {}
  }

  db.prepare("UPDATE assets SET thumb_status = 'pending' WHERE id = ?").run(row.id);
  enqueueThumb(row.id);
  res.json({ ok: true, queued: row.id });
});

// ─── POST /assets/rethumb-failed — re-queue all failed/missing thumbnails ─────

router.post('/assets/rethumb-failed', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, filename FROM assets WHERE thumb_status IN ('failed', 'none') OR thumb_status IS NULL"
  ).all() as { id: string; filename: string }[];

  const eligible = rows.filter((r) => needsThumbnail(r.filename));

  for (const row of eligible) {
    db.prepare("UPDATE assets SET thumb_status = 'pending' WHERE id = ?").run(row.id);
    enqueueThumb(row.id);
  }

  res.json({ ok: true, queued: eligible.length });
});

// ─── GET /folder/:id/download ─────────────────────────────────────────────────

router.get('/folder/:id/download', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id) as FolderRow | undefined;
  if (!folder) { res.status(404).json({ error: 'Folder not found' }); return; }

  const assets = db.prepare('SELECT * FROM assets WHERE folder_id = ?').all(folder.id) as AssetRow[];
  const zipName = `${folder.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 50) || 'folder'}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => { console.error('[zip]', err); res.end(); });
  archive.pipe(res);

  for (const asset of assets) {
    const filePath = assetFilePath(asset.id, asset.filename);
    if (fs.existsSync(filePath)) archive.file(filePath, { name: asset.filename });
  }

  archive.finalize();
});

// ─── POST /download/zip ───────────────────────────────────────────────────────

router.post('/download/zip', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const { asset_ids, folder_id, tag, filename: zipFilename } = req.body as {
    asset_ids?: string[];
    folder_id?: string;
    tag?: string;
    filename?: string;
  };

  if (!asset_ids?.length && !folder_id && !tag) {
    res.status(400).json({ error: 'Provide asset_ids, folder_id, or tag' });
    return;
  }

  let assets: AssetRow[] = [];
  if (asset_ids?.length) {
    const placeholders = asset_ids.map(() => '?').join(',');
    assets = db.prepare(`SELECT * FROM assets WHERE id IN (${placeholders})`).all(...asset_ids) as AssetRow[];
  } else if (folder_id) {
    assets = db.prepare('SELECT * FROM assets WHERE folder_id = ?').all(folder_id) as AssetRow[];
  } else if (tag) {
    const all = db.prepare('SELECT * FROM assets').all() as AssetRow[];
    assets = all.filter((a) => {
      const tags: string[] = JSON.parse(a.tags_json || '[]');
      return tags.includes(tag!);
    });
  }

  const zipName = zipFilename || 'thefabricatorsvault.zip';
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.on('error', (err) => { console.error('[zip]', err); res.end(); });
  archive.pipe(res);

  for (const asset of assets) {
    const filePath = assetFilePath(asset.id, asset.filename);
    if (fs.existsSync(filePath)) {
      const folderRow = asset.folder_id
        ? (db.prepare('SELECT name FROM folders WHERE id = ?').get(asset.folder_id) as { name: string } | undefined)
        : undefined;
      const prefix = folderRow ? folderRow.name : 'unassigned';
      archive.file(filePath, { name: `${prefix}/${asset.filename}` });
    }
  }

  archive.finalize();
});

export default router;
