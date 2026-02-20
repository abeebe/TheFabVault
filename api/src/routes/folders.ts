import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getDb } from '../db.js';
import type { FolderOut, FolderRow } from '../types/index.js';

const router = Router();

function toOut(row: FolderRow): FolderOut {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    createdAt: row.created_at,
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

  // Prevent circular parent reference
  if (parent_id && parent_id === id) {
    res.status(400).json({ error: 'A folder cannot be its own parent' });
    return;
  }

  if (parent_id) {
    const parent = db.prepare('SELECT id FROM folders WHERE id = ?').get(parent_id);
    if (!parent) {
      res.status(400).json({ error: 'Parent folder not found' });
      return;
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
