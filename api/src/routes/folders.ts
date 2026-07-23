import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import { isBareGuidName } from '../services/modelConvert.js';
import type { FolderOut, FolderRow } from '../types/index.js';

const router = Router();

function toOut(row: FolderRow): FolderOut {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdAt: row.created_at,
    // #2175: single source of truth for "named vs bare-GUID" — the bulk
    // convert wizard's Mode B relies on the exact same isBareGuidName
    // check the server applies when deciding which immediate children
    // become models, so the tree filter and the actual conversion rule
    // can never drift apart.
    isBareGuid: isBareGuidName(row.name),
  };
}

router.get('/folders', requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM folders ORDER BY name ASC').all() as FolderRow[];
  res.json(rows.map(toOut));
});

router.post('/folders', requireAuth, (req: Request, res: Response) => {
  const { name, parent_id } = req.body as { name?: string; parent_id?: string };
  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const db = getDb();

  // Validate parent exists if provided
  if (parent_id) {
    const parent = db.prepare('SELECT id FROM folders WHERE id = ?').get(parent_id);
    if (!parent) {
      res.status(400).json({ error: 'Parent folder not found' });
      return;
    }
  }

  const id = uuidv4();
  db.prepare(
    'INSERT INTO folders (id, name, parent_id) VALUES (?, ?, ?)'
  ).run(id, name.trim(), parent_id ?? null);

  const row = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow;
  res.status(201).json(toOut(row));
});

router.patch('/folder/:id', requireAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, parent_id } = req.body as { name?: string; parent_id?: string | null };
  const db = getDb();

  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
  if (!folder) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }

  // Prevent circular parent reference (self) and full cycles. Without
  // this check, dropping a folder into one of its own descendants would
  // detach the entire subtree from the root (it'd point at itself
  // through the descendant), making it unreachable from the tree walk.
  if (parent_id && parent_id === id) {
    res.status(400).json({ error: 'A folder cannot be its own parent' });
    return;
  }

  if (parent_id) {
    const parent = db.prepare('SELECT id, parent_id FROM folders WHERE id = ?').get(parent_id) as
      | { id: string; parent_id: string | null } | undefined;
    if (!parent) {
      res.status(400).json({ error: 'Parent folder not found' });
      return;
    }
    // Walk up from the new parent — if we hit the folder being moved,
    // the new parent is actually a descendant of it.
    let cursor: string | null = parent.parent_id;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id) {
        res.status(400).json({ error: 'Cannot move a folder into one of its own descendants' });
        return;
      }
      if (seen.has(cursor)) break; // safety net against any pre-existing cycle
      seen.add(cursor);
      const next = db.prepare('SELECT parent_id FROM folders WHERE id = ?').get(cursor) as
        | { parent_id: string | null } | undefined;
      cursor = next?.parent_id ?? null;
    }
  }

  const newName = name?.trim() ?? folder.name;
  const newParentId = parent_id === undefined ? folder.parent_id : (parent_id ?? null);

  db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(newName, newParentId, id);

  const updated = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow;
  res.json(toOut(updated));
});

router.delete('/folder/:id', requireAuth, (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getDb();

  const folder = db.prepare('SELECT id FROM folders WHERE id = ?').get(id);
  if (!folder) {
    res.status(404).json({ error: 'Folder not found' });
    return;
  }

  // Null out child folders' parent_id and assets' folder_id
  db.prepare('UPDATE folders SET parent_id = NULL WHERE parent_id = ?').run(id);
  db.prepare('UPDATE assets SET folder_id = NULL WHERE folder_id = ?').run(id);
  db.prepare('DELETE FROM folders WHERE id = ?').run(id);

  res.json({ ok: true });
});

export default router;
