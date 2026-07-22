// Unit tests for services/visibility.ts (#2167, Phase B). Pre-written +
// tested now even though no route threads this in yet (that's Phase D3
// per the restructure plan) — see that module's header comment.
//
// Exercises both the pure fragment-shape contract and, for confidence
// that the shape is actually usable, splices the fragment into a real
// query against a synthetic in-memory DB seeded with public/private
// rows owned by different users (same makeDb() pattern as
// migrations.test.ts — a plain better-sqlite3 Database, no HTTP/module
// boot needed since this is a pure function over caller-supplied
// values, not something reading req.user itself).

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { visibilityFragment } from '../services/visibility.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE models (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      visibility TEXT NOT NULL DEFAULT 'public'
    );
  `);
  db.prepare("INSERT INTO models (id, owner_id, visibility) VALUES ('pub-a', 'alice', 'public')").run();
  db.prepare("INSERT INTO models (id, owner_id, visibility) VALUES ('priv-a', 'alice', 'private')").run();
  db.prepare("INSERT INTO models (id, owner_id, visibility) VALUES ('priv-b', 'bob', 'private')").run();
  db.prepare("INSERT INTO models (id, owner_id, visibility) VALUES ('pub-b', 'bob', 'public')").run();
  return db;
}

function visibleIds(db: Database.Database, ctx: Parameters<typeof visibilityFragment>[0]): string[] {
  const frag = visibilityFragment(ctx);
  const rows = db.prepare(`SELECT id FROM models WHERE ${frag.sql} ORDER BY id`).all(...frag.params) as { id: string }[];
  return rows.map((r) => r.id);
}

describe('visibilityFragment: shape', () => {
  it('admin: sql is an unconditional true, no params', () => {
    const frag = visibilityFragment({ userId: 'alice', isAdmin: true });
    expect(frag.sql).toBe('1=1');
    expect(frag.params).toEqual([]);
  });

  it('authenticated non-admin: sql references visibility OR owner_id, with the caller id as the one param', () => {
    const frag = visibilityFragment({ userId: 'alice', isAdmin: false });
    expect(frag.sql).toContain("visibility = 'public'");
    expect(frag.sql).toContain('owner_id = ?');
    expect(frag.params).toEqual(['alice']);
  });

  it('no caller (userId null, not admin): sql is public-only, no params', () => {
    const frag = visibilityFragment({ userId: null, isAdmin: false });
    expect(frag.sql).toBe("visibility = 'public'");
    expect(frag.params).toEqual([]);
  });
});

describe('visibilityFragment: spliced into a real query', () => {
  it('admin sees every row regardless of owner or visibility', () => {
    const db = makeDb();
    expect(visibleIds(db, { userId: 'alice', isAdmin: true })).toEqual(['priv-a', 'priv-b', 'pub-a', 'pub-b']);
    // Even an admin id that owns nothing still sees everything.
    expect(visibleIds(db, { userId: 'carol', isAdmin: true })).toEqual(['priv-a', 'priv-b', 'pub-a', 'pub-b']);
  });

  it('an owner sees both public rows and their own private row, but not another owner\'s private row', () => {
    const db = makeDb();
    expect(visibleIds(db, { userId: 'alice', isAdmin: false })).toEqual(['priv-a', 'pub-a', 'pub-b']);
    expect(visibleIds(db, { userId: 'bob', isAdmin: false })).toEqual(['priv-b', 'pub-a', 'pub-b']);
  });

  it('a logged-out / unresolved caller sees only public rows', () => {
    const db = makeDb();
    expect(visibleIds(db, { userId: null, isAdmin: false })).toEqual(['pub-a', 'pub-b']);
  });

  it('a user who owns nothing sees only public rows, same as logged-out', () => {
    const db = makeDb();
    expect(visibleIds(db, { userId: 'carol', isAdmin: false })).toEqual(['pub-a', 'pub-b']);
  });
});
