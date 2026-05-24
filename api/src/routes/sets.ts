// Sets — lightweight asset grouping primitive.
//
// Distinct from folders (which dictate file location) and projects
// (which carry printer/laser/vinyl settings and an "active work"
// connotation). A set is just: name, optional description, optional
// cover asset, and a membership list. An asset can belong to many
// sets. Used for things like "model X has these 7 parts + a PDF" —
// related files that aren't a workflow.

import { Router, Request, Response } from 'express';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import { thumbExists } from '../services/fileStore.js';
import type {
  SetRow, SetOut, SetDetailOut, SetSuggestion, AssetRow, AssetOut,
} from '../types/index.js';

const router = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setToOut(row: SetRow, assetCount: number, coverThumbUrl: string | null): SetOut {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    coverAssetId: row.cover_asset_id,
    coverThumbUrl,
    assetCount,
    createdAt: row.created_at,
  };
}

// Mirrors routes/assets.ts#toOut. Kept inline to avoid coupling.
function assetRowToOut(row: AssetRow): AssetOut {
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

// Resolves the cover thumb URL — uses the explicit cover_asset_id if
// set and that asset has a usable thumbnail; otherwise falls back to
// the first member asset with a thumbnail. Null if nothing usable.
function resolveCoverThumb(coverAssetId: string | null, setId: string): string | null {
  const db = getDb();
  if (coverAssetId) {
    const row = db.prepare('SELECT id, thumb_status FROM assets WHERE id = ? AND deleted_at IS NULL')
      .get(coverAssetId) as { id: string; thumb_status: string } | undefined;
    if (row && row.thumb_status === 'done' && thumbExists(row.id)) {
      return `/thumb/${row.id}.jpg`;
    }
  }
  const fallback = db.prepare(
    `SELECT a.id FROM set_assets sa
     JOIN assets a ON a.id = sa.asset_id
     WHERE sa.set_id = ? AND a.deleted_at IS NULL AND a.thumb_status = 'done'
     ORDER BY sa.sort_order ASC, a.created_at DESC
     LIMIT 1`
  ).get(setId) as { id: string } | undefined;
  if (fallback && thumbExists(fallback.id)) return `/thumb/${fallback.id}.jpg`;
  return null;
}

// ─── GET /sets ────────────────────────────────────────────────────────────────

router.get('/sets', requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM sets ORDER BY name COLLATE NOCASE ASC').all() as SetRow[];
  const counts = db
    .prepare(`SELECT sa.set_id, COUNT(*) AS cnt
              FROM set_assets sa
              JOIN assets a ON a.id = sa.asset_id
              WHERE a.deleted_at IS NULL
              GROUP BY sa.set_id`)
    .all() as { set_id: string; cnt: number }[];
  const countMap = new Map(counts.map((c) => [c.set_id, c.cnt]));
  res.json(rows.map((r) => setToOut(r, countMap.get(r.id) ?? 0, resolveCoverThumb(r.cover_asset_id, r.id))));
});

// ─── POST /sets ───────────────────────────────────────────────────────────────

router.post('/sets', requireAuth, (req: Request, res: Response) => {
  const { name, description, assetIds } = req.body as {
    name?: string;
    description?: string;
    assetIds?: string[];
  };
  if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }

  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO sets (id, name, description) VALUES (?, ?, ?)')
    .run(id, name.trim(), description?.trim() || null);

  // Optional initial membership. Filter to assets that actually exist
  // and aren't trashed; silently skip invalid IDs.
  if (assetIds?.length) {
    const insertMember = db.prepare(
      `INSERT OR IGNORE INTO set_assets (set_id, asset_id, sort_order)
       VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM set_assets WHERE set_id = ?))`
    );
    const validId = db.prepare('SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL');
    db.transaction(() => {
      for (const aid of assetIds) {
        if (validId.get(aid)) insertMember.run(id, aid, id);
      }
    })();
  }

  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(id) as SetRow;
  const cnt = (db.prepare('SELECT COUNT(*) AS cnt FROM set_assets WHERE set_id = ?').get(id) as { cnt: number }).cnt;
  res.status(201).json(setToOut(row, cnt, resolveCoverThumb(row.cover_asset_id, id)));
});

// ─── GET /set/:id ─────────────────────────────────────────────────────────────

router.get('/set/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(req.params.id) as SetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const assetRows = db.prepare(
    `SELECT a.*
     FROM set_assets sa
     JOIN assets a ON a.id = sa.asset_id
     WHERE sa.set_id = ? AND a.deleted_at IS NULL
     ORDER BY sa.sort_order ASC, a.created_at DESC`
  ).all(row.id) as AssetRow[];

  const assets: AssetOut[] = assetRows.map(assetRowToOut);
  const detail: SetDetailOut = {
    ...setToOut(row, assets.length, resolveCoverThumb(row.cover_asset_id, row.id)),
    assets,
  };
  res.json(detail);
});

// ─── PATCH /set/:id ───────────────────────────────────────────────────────────

router.patch('/set/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(req.params.id) as SetRow | undefined;
  if (!row) { res.status(404).json({ error: 'Not found' }); return; }

  const { name, description, coverAssetId } = req.body as {
    name?: string;
    description?: string | null;
    coverAssetId?: string | null;
  };

  if (name !== undefined) {
    if (!name.trim()) { res.status(400).json({ error: 'name cannot be empty' }); return; }
    db.prepare('UPDATE sets SET name = ? WHERE id = ?').run(name.trim(), row.id);
  }
  if (description !== undefined) {
    db.prepare('UPDATE sets SET description = ? WHERE id = ?').run(description?.trim() || null, row.id);
  }
  if (coverAssetId !== undefined) {
    if (coverAssetId) {
      // Cover must be a member of the set.
      const ok = db.prepare('SELECT 1 FROM set_assets WHERE set_id = ? AND asset_id = ?').get(row.id, coverAssetId);
      if (!ok) { res.status(400).json({ error: 'Cover asset must be a member of the set' }); return; }
    }
    db.prepare('UPDATE sets SET cover_asset_id = ? WHERE id = ?').run(coverAssetId || null, row.id);
  }

  const updated = db.prepare('SELECT * FROM sets WHERE id = ?').get(row.id) as SetRow;
  const cnt = (db.prepare('SELECT COUNT(*) AS cnt FROM set_assets WHERE set_id = ?').get(row.id) as { cnt: number }).cnt;
  res.json(setToOut(updated, cnt, resolveCoverThumb(updated.cover_asset_id, row.id)));
});

// ─── DELETE /set/:id ──────────────────────────────────────────────────────────

router.delete('/set/:id', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const info = db.prepare('DELETE FROM sets WHERE id = ?').run(req.params.id);
  if (info.changes === 0) { res.status(404).json({ error: 'Not found' }); return; }
  res.status(204).end();
});

// ─── POST /set/:id/assets — add members ───────────────────────────────────────

router.post('/set/:id/assets', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const set = db.prepare('SELECT id FROM sets WHERE id = ?').get(req.params.id) as { id: string } | undefined;
  if (!set) { res.status(404).json({ error: 'Not found' }); return; }

  const { assetIds } = req.body as { assetIds?: string[] };
  if (!assetIds?.length) { res.status(400).json({ error: 'assetIds required' }); return; }

  const insertMember = db.prepare(
    `INSERT OR IGNORE INTO set_assets (set_id, asset_id, sort_order)
     VALUES (?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM set_assets WHERE set_id = ?))`
  );
  const validId = db.prepare('SELECT 1 FROM assets WHERE id = ? AND deleted_at IS NULL');
  let added = 0;
  db.transaction(() => {
    for (const aid of assetIds) {
      if (validId.get(aid)) {
        const r = insertMember.run(set.id, aid, set.id);
        if (r.changes > 0) added++;
      }
    }
  })();
  res.json({ added });
});

// ─── DELETE /set/:id/asset/:assetId — remove member ───────────────────────────

router.delete('/set/:id/asset/:assetId', requireAuth, (req: Request, res: Response) => {
  const db = getDb();
  const r = db.prepare('DELETE FROM set_assets WHERE set_id = ? AND asset_id = ?')
    .run(req.params.id, req.params.assetId);
  if (r.changes === 0) { res.status(404).json({ error: 'Not in set' }); return; }
  res.status(204).end();
});

// ─── GET /sets/suggest — auto-detect groupings ────────────────────────────────
//
// Heuristic: within each folder, normalize each filename by stripping
// the extension and common per-part suffixes, then group by the
// resulting stem. Any group with 2+ files becomes a suggestion. PDFs
// in the same folder whose stem overlaps a group are added as
// "instructions" members.

// Per-part suffix patterns. Applied repeatedly until the name stops
// changing — covers names like `pumpkin_part_1_supported`.
const PART_SUFFIXES = [
  /_v\d+$/i,
  /_supported$|_unsupported$|_supports$|_presupported$|_pre_supported$/i,
  /_(bottom|top|middle|left|right|center|front|back|inner|outer|upper|lower)$/i,
  /_(part|piece|section)_?\d*$/i,
  /_split\d*$|_split_\d+$/i,
  /_(mesh|body|shell|base|core)$/i,
  /_\d+$/i, // trailing _01, _02 etc.
  /[\-\s]copy(\s?\d+)?$/i, // "name - Copy", "name copy 2"
];

function stemOf(filename: string): string {
  let s = filename.slice(0, filename.lastIndexOf('.')).toLowerCase();
  // Normalize separators so "Skull-Top" and "skull_top" collapse.
  s = s.replace(/[\s\-]+/g, '_');
  let prev: string;
  do {
    prev = s;
    for (const re of PART_SUFFIXES) s = s.replace(re, '');
  } while (s !== prev && s.length > 0);
  return s;
}

function titleCase(stem: string): string {
  return stem
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

router.get('/sets/suggest', requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  // Only suggest from assets not yet in ANY set, so re-running doesn't
  // re-propose what the user already organized.
  const rows = db.prepare(
    `SELECT a.id, a.filename, a.folder_id
     FROM assets a
     WHERE a.deleted_at IS NULL
       AND a.id NOT IN (SELECT asset_id FROM set_assets)`
  ).all() as Array<{ id: string; filename: string; folder_id: string | null }>;

  // folderId → stem → [assets]
  const groups = new Map<string, Map<string, Array<{ id: string; filename: string }>>>();
  for (const row of rows) {
    const folderKey = row.folder_id ?? '__root__';
    const stem = stemOf(row.filename);
    if (!stem) continue;
    if (!groups.has(folderKey)) groups.set(folderKey, new Map());
    const folderMap = groups.get(folderKey)!;
    if (!folderMap.has(stem)) folderMap.set(stem, []);
    folderMap.get(stem)!.push({ id: row.id, filename: row.filename });
  }

  // Fetch folder names for suggestion display.
  const folderNames = new Map<string, string>();
  for (const f of db.prepare('SELECT id, name FROM folders').all() as Array<{ id: string; name: string }>) {
    folderNames.set(f.id, f.name);
  }

  const suggestions: SetSuggestion[] = [];
  for (const [folderKey, folderMap] of groups) {
    for (const [stem, members] of folderMap) {
      if (members.length < 2) continue;
      // Skip stems that are too short to be meaningful (e.g. "v", "01")
      if (stem.replace(/[_\d]/g, '').length < 3) continue;
      suggestions.push({
        name: titleCase(stem),
        folderId: folderKey === '__root__' ? null : folderKey,
        folderName: folderKey === '__root__' ? null : (folderNames.get(folderKey) ?? null),
        assetIds: members.map((m) => m.id),
      });
    }
  }

  // Largest groups first (most signal).
  suggestions.sort((a, b) => b.assetIds.length - a.assetIds.length);
  res.json({ suggestions });
});

export default router;
