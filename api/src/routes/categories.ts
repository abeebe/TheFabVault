// Categories — the curated top-level tree seeded by db.ts's
// seedCategoriesIfEmpty() (8 default rows, self-referential parent_id,
// same nesting shape as folders.parent_id/sub_assemblies.parent_id).
// Follow-up from Remy's A4 #2157 finding: the table existed with no
// route exposing it, so ModelPage's Edit Details categoryId was a plain
// text field (#2164, pulls forward the Phase B1 categories slice — see
// Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md
// §3). This is intentionally the whole surface for now — no category
// admin UI ships with this ticket (that's Phase B proper), just enough
// route to feed ModelPage's picker and give admins a CUD surface to
// build that UI against later.
//
// Read is requireAuth (every logged-in user needs the full list to
// populate a category picker); write is requireAdmin, same split as
// folders.ts vs admin.ts. Once Phase D's real multi-role pass lands,
// requireAuth here may need to become "requireAuth + visible to
// members" — today requireAuth and requireAdmin are equivalent (schema
// only allows the 'admin' role), see auth.ts's requireAdmin comment.

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requireAdmin } from '../auth.js';
import { getDb } from '../db.js';
import type { CategoryOut, CategoryRow } from '../types/index.js';

const router = Router();

function toOut(row: CategoryRow): CategoryOut {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
  };
}

// GET /categories — full tree, flat list (parentId lets the client
// build hierarchy client-side, same contract shape as GET /folders).
// requireAuth, not requireAdmin: every user needs this to populate a
// category picker, not just admins.
router.get('/categories', requireAuth, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM categories ORDER BY sort_order ASC, name ASC'
  ).all() as CategoryRow[];
  res.json(rows.map(toOut));
});

// POST /categories — requireAdmin. sortOrder defaults to "append at the
// end" (max existing sort_order + 1) rather than 0, so admin-created
// categories don't silently jump ahead of the seeded tree; ties are
// broken by name in the GET ordering regardless.
router.post('/categories', requireAdmin, (req: Request, res: Response) => {
  const { name, parentId, sortOrder } = req.body as {
    name?: string;
    parentId?: string | null;
    sortOrder?: number;
  };

  if (!name?.trim()) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const db = getDb();

  if (parentId) {
    const parent = db.prepare('SELECT id FROM categories WHERE id = ?').get(parentId);
    if (!parent) { res.status(400).json({ error: 'Parent category not found' }); return; }
  }

  let resolvedSortOrder = sortOrder;
  if (resolvedSortOrder === undefined) {
    const { maxSort } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS maxSort FROM categories').get() as { maxSort: number };
    resolvedSortOrder = maxSort + 1;
  }

  const id = uuidv4();
  db.prepare(
    'INSERT INTO categories (id, name, parent_id, sort_order) VALUES (?, ?, ?, ?)'
  ).run(id, name.trim(), parentId || null, resolvedSortOrder);

  const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow;
  res.status(201).json(toOut(row));
});

// PATCH /category/:id — requireAdmin. Same self-parent + cycle guard as
// folders.ts's PATCH /folder/:id (identical self-referential shape);
// see that file's comment for the full rationale.
router.patch('/category/:id', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, parentId, sortOrder } = req.body as {
    name?: string;
    parentId?: string | null;
    sortOrder?: number;
  };
  const db = getDb();

  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined;
  if (!category) { res.status(404).json({ error: 'Category not found' }); return; }

  if (parentId && parentId === id) {
    res.status(400).json({ error: 'A category cannot be its own parent' });
    return;
  }

  if (parentId) {
    const parent = db.prepare('SELECT id, parent_id FROM categories WHERE id = ?').get(parentId) as
      | { id: string; parent_id: string | null } | undefined;
    if (!parent) { res.status(400).json({ error: 'Parent category not found' }); return; }

    let cursor: string | null = parent.parent_id;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id) {
        res.status(400).json({ error: 'Cannot move a category into one of its own descendants' });
        return;
      }
      if (seen.has(cursor)) break; // safety net against any pre-existing cycle
      seen.add(cursor);
      const next = db.prepare('SELECT parent_id FROM categories WHERE id = ?').get(cursor) as
        | { parent_id: string | null } | undefined;
      cursor = next?.parent_id ?? null;
    }
  }

  const newName = name?.trim() || category.name;
  const newParentId = parentId === undefined ? category.parent_id : (parentId ?? null);
  const newSortOrder = sortOrder === undefined ? category.sort_order : sortOrder;

  db.prepare('UPDATE categories SET name = ?, parent_id = ?, sort_order = ? WHERE id = ?')
    .run(newName, newParentId, newSortOrder, id);

  const updated = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow;
  res.json(toOut(updated));
});

// DELETE /category/:id — requireAdmin.
//
// Two things a delete here could touch:
//  - models.category_id: the v15 schema already declares this
//    ON DELETE SET NULL, so any model referencing this category falls
//    back to uncategorized automatically (foreign_keys=ON, db.ts) — no
//    app-layer handling needed, that's the whole point of the FK.
//  - child categories (categories.parent_id, also ON DELETE SET NULL):
//    deliberately NOT left to the FK default here. Letting the schema
//    auto-promote children to top-level on parent delete is a silent
//    tree restructure an admin didn't ask for. This route blocks the
//    delete instead and asks for an explicit reparent/delete-children-
//    first — stricter than the schema's own default, on purpose.
router.delete('/category/:id', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getDb();

  const category = db.prepare('SELECT id FROM categories WHERE id = ?').get(id);
  if (!category) { res.status(404).json({ error: 'Category not found' }); return; }

  const { c } = db.prepare('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ?').get(id) as { c: number };
  if (c > 0) {
    res.status(400).json({ error: 'Category has subcategories — reparent or delete them first' });
    return;
  }

  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ ok: true });
});

export default router;
