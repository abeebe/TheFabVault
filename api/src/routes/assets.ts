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
  versionFilePath,
} from '../services/fileStore.js';
import { enqueueThumb } from '../services/thumbGen.js';
import { extractMeta } from '../services/metaExtract.js';
import { saveUploadedFile, needsThumbnail, findAssetByHash } from '../services/assetUpload.js';
import { archiveAndReplaceAssetFile } from '../services/assetVersion.js';
import type { AssetOut, AssetRow, FolderRow, VersionRow, VersionOut } from '../types/index.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

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
    category: row.category ?? null,
    deletedAt: row.deleted_at ?? null,
    rating: row.rating ?? null,
    isFavorite: Boolean(row.is_favorite),
  };
}

function toVersionOut(row: VersionRow): VersionOut {
  return {
    id: row.id,
    assetId: row.asset_id,
    versionNum: row.version_num,
    filename: row.filename,
    size: row.size,
    fileHash: row.file_hash ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at,
  };
}

// saveUploadedFile / needsThumbnail live in services/assetUpload.ts now —
// shared with the folder-import batch endpoints (routes/manifestImport.ts)
// so a genuinely-new file is created exactly the same way regardless of
// whether it arrived via the single-file upload button or a folder import.

// ─── POST /check-hash ─────────────────────────────────────────────────────────
// Check if a file with a given SHA-256 hash already exists in the vault.
// Used by the frontend before uploading to warn about duplicates.

router.post('/check-hash', requireAuth, (req: Request, res: Response) => {
  const { hash } = req.body as { hash?: string };
  if (!hash || typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
    res.status(400).json({ error: 'Invalid hash — expected 64-char hex SHA-256' });
    return;
  }
  const db = getDb();
  // deleted_at IS NULL — must match findAssetByHash (services/assetUpload.ts),
  // which link-existing uses. Without this filter, Preview can promise "already
  // in your vault, will link" for a hash that only matches a TRASHED asset;
  // Commit then hard-404s that file (link-existing has no bytes to fall back
  // to a fresh upload), per Remy's review.
  const row = db.prepare('SELECT * FROM assets WHERE file_hash = ? AND deleted_at IS NULL LIMIT 1').get(hash) as AssetRow | undefined;
  if (!row) {
    res.json({ exists: false });
    return;
  }
  res.json({ exists: true, asset: toOut(row) });
});

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

// SQL fragments matching the auto-category logic in
// web/src/App.tsx#getAssetCategory. Keep extension lists in sync with
// THREE_D_EXTS / TWO_D_EXTS below and with the frontend.
function categoryWhereFragment(category: string): { sql: string; params: unknown[] } {
  const likeAny = (exts: Iterable<string>) =>
    Array.from(exts).map(() => 'LOWER(filename) LIKE ?').join(' OR ');
  const params = (exts: Iterable<string>) => Array.from(exts).map((e) => `%${e}`);

  if (category === '3dmodel') {
    return {
      sql: ` AND (category = '3dmodel' OR (category IS NULL AND (${likeAny(THREE_D_EXTS)})))`,
      params: params(THREE_D_EXTS),
    };
  }
  if (category === '2d') {
    return {
      sql: ` AND (category = '2d' OR (category IS NULL AND (${likeAny(TWO_D_EXTS)})))`,
      params: params(TWO_D_EXTS),
    };
  }
  if (category === 'uncategorized') {
    // Not an override category AND no recognized extension.
    return {
      sql: ` AND (category IS NULL OR category NOT IN ('3dmodel', '2d'))
             AND NOT (${likeAny(THREE_D_EXTS)})
             AND NOT (${likeAny(TWO_D_EXTS)})`,
      params: [...params(THREE_D_EXTS), ...params(TWO_D_EXTS)],
    };
  }
  return { sql: '', params: [] };
}

router.get('/assets', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const {
    q, tags: tagsParam, folder_id, category, favorites,
    limit = '100', offset = '0', sort = 'date_desc',
  } = req.query as Record<string, string>;

  const orderBy = SORT_MAP[sort] ?? SORT_MAP['date_desc'];

  let whereClause = ' WHERE deleted_at IS NULL';
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

  if (favorites === 'true' || favorites === '1') {
    whereClause += ' AND is_favorite = 1';
  }

  if (category) {
    const frag = categoryWhereFragment(category);
    if (frag.sql) {
      whereClause += frag.sql;
      whereParams.push(...frag.params);
    }
  }

  // Tag filter — runs against tags_json (JSON array stored as text). LIKE
  // with quoted tag avoids false positives like "foo" matching "foobar".
  if (tagsParam) {
    const filterTags = tagsParam.split(',').map((t) => t.trim()).filter(Boolean);
    for (const tag of filterTags) {
      whereClause += ' AND tags_json LIKE ?';
      whereParams.push(`%"${tag}"%`);
    }
  }

  // Total count (before pagination) — now matches the filtered set so
  // pagination doesn't show empty pages for category/favorite filters.
  const total = (db.prepare(`SELECT COUNT(*) as count FROM assets${whereClause}`).get(...whereParams) as { count: number }).count;

  const sql = `SELECT * FROM assets${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
  const params = [...whereParams, parseInt(limit, 10), parseInt(offset, 10)];

  const rows = db.prepare(sql).all(...params) as AssetRow[];

  res.json({ items: rows.map(toOut), total });
});

// ─── GET /asset-stats ─────────────────────────────────────────────────────────
// Returns category counts across ALL non-trashed assets (the /assets list
// is paginated, so its categories would only reflect the current page).
// Keep the extension lists in sync with web/src/App.tsx#getAssetCategory.

const THREE_D_EXTS = new Set(['.stl', '.obj', '.3mf', '.lys', '.ctb', '.photon']);
const TWO_D_EXTS = new Set(['.svg', '.dxf', '.cdr', '.ai', '.eps', '.pdf', '.lbrn', '.lbrn2']);

router.get('/asset-stats', requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT filename, category, is_favorite, size FROM assets WHERE deleted_at IS NULL')
    .all() as Array<{ filename: string; category: string | null; is_favorite: number; size: number }>;

  let favorites = 0;
  let threeDmodel = 0;
  let twoD = 0;
  let uncategorized = 0;
  let totalSize = 0;

  for (const row of rows) {
    totalSize += row.size ?? 0;
    if (row.is_favorite) favorites++;
    if (row.category === '3dmodel') { threeDmodel++; continue; }
    if (row.category === '2d') { twoD++; continue; }
    const dotIdx = row.filename.lastIndexOf('.');
    const ext = dotIdx >= 0 ? row.filename.slice(dotIdx).toLowerCase() : '';
    if (THREE_D_EXTS.has(ext)) threeDmodel++;
    else if (TWO_D_EXTS.has(ext)) twoD++;
    else uncategorized++;
  }

  res.json({ total: rows.length, totalSize, favorites, threeDmodel, twoD, uncategorized });
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

// ─── PATCH /asset/:id/category ───────────────────────────────────────────────

router.patch('/asset/:id/category', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const { category } = req.body as { category?: string | null };
  // null clears the override (reverts to auto-detect); a string sets an explicit category
  const value = category === undefined ? row.category : (category ?? null);

  db.prepare('UPDATE assets SET category = ? WHERE id = ?').run(value, row.id);
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
// Soft-deletes by default (moves to trash). Pass ?permanent=true to hard-delete.

router.delete('/asset/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  if (req.query.permanent === 'true') {
    // Hard delete — remove from DB and disk
    db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
    cleanupAsset(row.id, { deleteFile: true });
  } else {
    // Soft delete — move to trash
    db.prepare('UPDATE assets SET deleted_at = unixepoch() WHERE id = ?').run(row.id);
  }
  res.json({ ok: true });
});

// ─── GET /trash ───────────────────────────────────────────────────────────────

router.get('/trash', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM assets WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'
  ).all() as AssetRow[];
  res.json({ items: rows.map(toOut), total: rows.length });
});

// ─── POST /asset/:id/restore ──────────────────────────────────────────────────

router.post('/asset/:id/restore', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found in trash' }); return; }
  db.prepare('UPDATE assets SET deleted_at = NULL WHERE id = ?').run(row.id);
  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id) as AssetRow;
  res.json(toOut(updated));
});

// ─── DELETE /trash ────────────────────────────────────────────────────────────
// Permanently deletes ALL trashed assets.

router.delete('/trash', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM assets WHERE deleted_at IS NOT NULL').all() as AssetRow[];
  for (const row of rows) {
    db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
    cleanupAsset(row.id, { deleteFile: true });
  }
  res.json({ ok: true, deleted: rows.length });
});

// ─── PATCH /asset/:id/rating ──────────────────────────────────────────────────

router.patch('/asset/:id/rating', requireAuth, (req: Request, res: Response) => {
  const { rating } = req.body as { rating?: number | null };
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  if (rating !== null && rating !== undefined && (rating < 1 || rating > 5 || !Number.isInteger(rating))) {
    res.status(400).json({ error: 'Rating must be 1–5 or null' });
    return;
  }
  db.prepare('UPDATE assets SET rating = ? WHERE id = ?').run(rating ?? null, row.id);
  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id) as AssetRow;
  res.json(toOut(updated));
});

// ─── PATCH /asset/:id/favorite ────────────────────────────────────────────────

router.patch('/asset/:id/favorite', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as AssetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const { favorite } = req.body as { favorite?: boolean };
  if (typeof favorite !== 'boolean') { res.status(400).json({ error: 'favorite must be a boolean' }); return; }
  db.prepare('UPDATE assets SET is_favorite = ? WHERE id = ?').run(favorite ? 1 : 0, row.id);
  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(row.id) as AssetRow;
  res.json(toOut(updated));
});

// ─── GET /asset/:id/versions ──────────────────────────────────────────────────

router.get('/asset/:id/versions', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as { id: string } | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }
  const versions = db.prepare(
    'SELECT * FROM asset_versions WHERE asset_id = ? ORDER BY version_num DESC'
  ).all(row.id) as VersionRow[];
  res.json({ versions: versions.map(toVersionOut) });
});

// ─── POST /asset/:id/version — upload a new version of an asset ───────────────

router.post('/asset/:id/version', requireAuth, upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: 'No file provided' }); return; }
  const db = getDb();
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as AssetRow | undefined;
  if (!asset) { res.status(404).json({ error: 'Not found' }); return; }

  const notes = (req.body.notes as string | undefined) ?? null;

  // Shared with the mount-scan auto-versioning path (services/mountImport.ts)
  // — see services/assetVersion.ts header for why this is extracted.
  const { asset: updated } = archiveAndReplaceAssetFile(
    db,
    asset,
    req.file.buffer,
    req.file.originalname || asset.filename,
    notes,
  );

  res.json({ asset: toOut(updated) });
});

// ─── POST /asset/:id/version/:versionId/restore — restore a previous version ──

router.post('/asset/:id/version/:versionId/restore', requireAuth, async (req: Request, res: Response) => {
  const db = getDb();
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(req.params.id) as AssetRow | undefined;
  if (!asset) { res.status(404).json({ error: 'Asset not found' }); return; }

  const version = db.prepare(
    'SELECT * FROM asset_versions WHERE id = ? AND asset_id = ?'
  ).get(req.params.versionId, asset.id) as VersionRow | undefined;
  if (!version) { res.status(404).json({ error: 'Version not found' }); return; }

  const versionFile = versionFilePath(asset.id, version.id, version.filename);
  if (!fs.existsSync(versionFile)) {
    res.status(404).json({ error: 'Version file not found on disk' });
    return;
  }

  // Replace the current asset file with the version file
  const destPath = assetFilePath(asset.id, version.filename);
  const oldPath = assetFilePath(asset.id, asset.filename);
  fs.copyFileSync(versionFile, destPath);
  if (version.filename !== asset.filename && fs.existsSync(oldPath)) {
    try { fs.unlinkSync(oldPath); } catch {}
  }

  db.prepare(
    `UPDATE assets SET filename = ?, size = ?, file_hash = ?, thumb_status = ? WHERE id = ?`
  ).run(version.filename, version.size, version.file_hash, needsThumbnail(version.filename) ? 'pending' : 'none', asset.id);

  if (needsThumbnail(version.filename)) enqueueThumb(asset.id);

  const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(asset.id) as AssetRow;
  res.json({ asset: toOut(updated) });
});

// ─── DELETE /asset/:id/version/:versionId ─────────────────────────────────────

router.delete('/asset/:id/version/:versionId', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const version = db.prepare(
    'SELECT * FROM asset_versions WHERE id = ? AND asset_id = ?'
  ).get(req.params.versionId, req.params.id) as VersionRow | undefined;
  if (!version) { res.status(404).json({ error: 'Version not found' }); return; }

  // Delete the version file from disk
  const vFile = versionFilePath(req.params.id, version.id, version.filename);
  try { if (fs.existsSync(vFile)) fs.unlinkSync(vFile); } catch {}

  db.prepare('DELETE FROM asset_versions WHERE id = ?').run(version.id);
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
