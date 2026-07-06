// Structural validation for sub-assembly reparenting — the cycle guard.
//
// sub_assemblies is self-referential (parent_id), structurally identical to
// folders. routes/folders.ts's PATCH /folder/:id already solves this exact
// problem (walk up from the proposed new parent; if the walk hits the node
// being moved, the new parent is actually a descendant of it, and applying
// the move would detach the whole subtree from the tree root). This is that
// same algorithm, ported and pulled into its own function so it's directly
// unit-testable against an in-memory DB rather than only reachable through
// an HTTP round-trip.

import type Database from 'better-sqlite3';

export type ReparentValidation =
  | { ok: true }
  | { ok: false; error: string };

// Validates a proposed (nodeId -> newParentId) reparent.
//   - a node cannot be its own parent
//   - the new parent must exist and belong to the same project (structurally
//     unenforced by the schema — sub_assemblies has no CHECK tying a child's
//     project_id to its parent's, this is an application-layer invariant)
//   - the new parent cannot be a descendant of the node being moved
export function validateReparent(
  db: Database.Database,
  nodeId: string,
  nodeProjectId: string,
  newParentId: string,
): ReparentValidation {
  if (newParentId === nodeId) {
    return { ok: false, error: 'A sub-assembly cannot be its own parent' };
  }

  const parent = db.prepare('SELECT id, project_id, parent_id FROM sub_assemblies WHERE id = ?').get(newParentId) as
    | { id: string; project_id: string; parent_id: string | null } | undefined;
  if (!parent) {
    return { ok: false, error: 'Parent sub-assembly not found' };
  }
  if (parent.project_id !== nodeProjectId) {
    return { ok: false, error: 'Cannot move a sub-assembly to a different project' };
  }

  // Walk up from the new parent — if we hit the node being moved, the new
  // parent is a descendant of it.
  let cursor: string | null = parent.parent_id;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === nodeId) {
      return { ok: false, error: 'Cannot move a sub-assembly into one of its own descendants' };
    }
    if (seen.has(cursor)) break; // safety net against any pre-existing cycle
    seen.add(cursor);
    const next = db.prepare('SELECT parent_id FROM sub_assemblies WHERE id = ?').get(cursor) as
      | { parent_id: string | null } | undefined;
    cursor = next?.parent_id ?? null;
  }

  return { ok: true };
}
