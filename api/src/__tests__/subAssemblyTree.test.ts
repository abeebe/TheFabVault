// Tests for the sub-assembly reparent cycle guard (services/subAssemblyTree.ts),
// the server-side authority ported from routes/folders.ts's PATCH /folder/:id.
// Sage's QA note in the PRD specifically calls out this class of bug
// (off-by-one-in-spirit on tree invariants) as high-risk for a first pass.

import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { validateReparent } from '../services/subAssemblyTree.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE sub_assemblies (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

function makeProject(db: Database.Database): string {
  const id = uuidv4();
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(id, 'Test Project');
  return id;
}

function makeSA(db: Database.Database, projectId: string, name: string, parentId: string | null = null): string {
  const id = uuidv4();
  db.prepare('INSERT INTO sub_assemblies (id, project_id, parent_id, name) VALUES (?, ?, ?, ?)')
    .run(id, projectId, parentId, name);
  return id;
}

describe('validateReparent', () => {
  let db: Database.Database;
  let projectId: string;

  beforeEach(() => {
    db = makeDb();
    projectId = makeProject(db);
  });

  it('accepts moving a node to an unrelated sibling within the same project', () => {
    const a = makeSA(db, projectId, 'Right Foot');
    const b = makeSA(db, projectId, 'Left Foot');
    expect(validateReparent(db, a, projectId, b)).toEqual({ ok: true });
  });

  it('rejects a node being made its own parent', () => {
    const a = makeSA(db, projectId, 'Dome');
    expect(validateReparent(db, a, projectId, a)).toEqual({
      ok: false,
      error: 'A sub-assembly cannot be its own parent',
    });
  });

  it('rejects a nonexistent proposed parent', () => {
    const a = makeSA(db, projectId, 'Dome');
    const result = validateReparent(db, a, projectId, 'does-not-exist');
    expect(result.ok).toBe(false);
  });

  it('rejects moving a node under a proposed parent that belongs to a different project', () => {
    const otherProjectId = makeProject(db);
    const a = makeSA(db, projectId, 'Right Foot');
    const foreignParent = makeSA(db, otherProjectId, 'Someone Else\'s Node');
    const result = validateReparent(db, a, projectId, foreignParent);
    expect(result).toEqual({
      ok: false,
      error: 'Cannot move a sub-assembly to a different project',
    });
  });

  it('rejects the direct-child cycle: a node cannot become the parent of its own parent', () => {
    // Leg -> Foot. Attempting to move Leg under Foot would detach the
    // subtree from the root (Foot would point at Leg, which points at Foot).
    const leg = makeSA(db, projectId, 'Leg');
    const foot = makeSA(db, projectId, 'Foot', leg);
    const result = validateReparent(db, leg, projectId, foot);
    expect(result).toEqual({
      ok: false,
      error: 'Cannot move a sub-assembly into one of its own descendants',
    });
  });

  it('rejects a deep cycle: a node cannot move under a grandchild several levels down', () => {
    // Leg -> Foot -> Ankle -> Toe. Moving Leg under Toe must be rejected —
    // Toe is a descendant of Leg at depth 3, not just a direct child.
    const leg = makeSA(db, projectId, 'Leg');
    const foot = makeSA(db, projectId, 'Foot', leg);
    const ankle = makeSA(db, projectId, 'Ankle', foot);
    const toe = makeSA(db, projectId, 'Toe', ankle);

    const result = validateReparent(db, leg, projectId, toe);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/descendants/);
    }
  });

  it('accepts moving a deeply nested node up to become a new top-level root', () => {
    // Simulates dropping onto Organize Mode's "Top level" pseudo-row. Not
    // exercised by validateReparent directly (that's parentId=null, handled
    // by the route without calling this function), but confirms a node CAN
    // still be validly re-homed to an unrelated top-level sibling.
    const leg = makeSA(db, projectId, 'Leg');
    const foot = makeSA(db, projectId, 'Foot', leg);
    const dome = makeSA(db, projectId, 'Dome'); // unrelated top-level node
    expect(validateReparent(db, foot, projectId, dome)).toEqual({ ok: true });
  });

  it('does not falsely reject moving a node next to (not under) its own sibling\'s descendant', () => {
    // Right Foot and Left Foot are siblings. Right Foot has a child
    // (Right Toe). Moving Left Foot under Right Toe is a legitimate
    // structural change (Left Foot is not an ancestor of Right Toe) and
    // must be accepted.
    const rightFoot = makeSA(db, projectId, 'Right Foot');
    const leftFoot = makeSA(db, projectId, 'Left Foot');
    const rightToe = makeSA(db, projectId, 'Right Toe', rightFoot);
    expect(validateReparent(db, leftFoot, projectId, rightToe)).toEqual({ ok: true });
  });
});
