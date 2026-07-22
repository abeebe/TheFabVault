// Tests for the migration runner's transactionality (#2154, Phase A) and
// the real v15 schema it now applies.
//
// Two different fixtures, deliberately:
//   1. A synthetic migrations array (never touches the real MIGRATIONS
//      strings in db.ts) proves the runner itself is atomic — one
//      generic test that stays true regardless of what any future
//      migration's SQL looks like.
//   2. The real, exported MIGRATIONS array proves v15 specifically:
//      fresh DB reaches the expected schema, and a v14-shaped admin row
//      survives the users table-copy with its role preserved.
//
// db.ts's own runMigrations()/MIGRATIONS export take a plain
// better-sqlite3 Database and never touch getDb()'s module-level
// singleton or the filesystem — no vi.resetModules()/DATA_DIR dance
// needed here, unlike auth.test.ts.

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, MIGRATIONS } from '../db.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('runMigrations: atomicity (synthetic migrations, real db.ts runner)', () => {
  it('a migration that fails partway through a multi-statement string leaves user_version AND schema exactly as they were before it ran', () => {
    const db = makeDb();

    const goodMigrations = [
      'CREATE TABLE widgets (id TEXT PRIMARY KEY);',
      'CREATE TABLE gadgets (id TEXT PRIMARY KEY);',
    ];
    runMigrations(db, goodMigrations);
    expect(db.pragma('user_version', { simple: true })).toBe(2);

    // Third migration: first statement succeeds, second is invalid SQL.
    // If the runner weren't transactional, `widgets_v2` would exist on
    // disk right now even though this whole migration is about to throw.
    const failingMigrations = [
      ...goodMigrations,
      'CREATE TABLE widgets_v2 (id TEXT PRIMARY KEY); THIS IS NOT VALID SQL;',
    ];

    expect(() => runMigrations(db, failingMigrations)).toThrow();

    // user_version did not advance to 3.
    expect(db.pragma('user_version', { simple: true })).toBe(2);

    // Neither statement from the failed migration's script left a trace
    // — not just the one that literally errored, but the one before it
    // in the same script, which SQLite would normally have committed
    // fine on its own outside a transaction.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets_v2'")
      .all();
    expect(tables).toEqual([]);

    // And the runner is retryable: fix the SQL, call again, it picks up
    // exactly where it left off (still at version 2) and succeeds.
    const fixedMigrations = [
      ...goodMigrations,
      'CREATE TABLE widgets_v2 (id TEXT PRIMARY KEY);',
    ];
    expect(() => runMigrations(db, fixedMigrations)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    const tablesAfterFix = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets_v2'")
      .all();
    expect(tablesAfterFix).toHaveLength(1);
  });

  it('does not attempt any migration after the one that failed', () => {
    const db = makeDb();
    const migrations = [
      'CREATE TABLE a (id TEXT PRIMARY KEY);',
      'NOT VALID SQL AT ALL;',
      'CREATE TABLE c (id TEXT PRIMARY KEY);',
    ];
    expect(() => runMigrations(db, migrations)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    const cTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'c'")
      .all();
    expect(cTable).toEqual([]); // never reached — the loop stopped at the failure
  });
});

describe('MIGRATIONS: fresh DB reaches v15 with the expected schema', () => {
  it('applies all migrations and lands on user_version === MIGRATIONS.length', () => {
    const db = makeDb();
    runMigrations(db);
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBe(15);
  });

  it('creates categories/models/model_files/print_profiles with the expected columns', () => {
    const db = makeDb();
    runMigrations(db);

    const tableNames = (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]).map((r) => r.name);
    expect(tableNames).toEqual(
      expect.arrayContaining(['users', 'categories', 'models', 'model_files', 'print_profiles']),
    );

    const userCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
    expect(userCols).toEqual(
      expect.arrayContaining(['id', 'username', 'password_hash', 'role', 'display_name', 'disabled', 'created_at', 'updated_at']),
    );

    const modelCols = (db.prepare('PRAGMA table_info(models)').all() as { name: string }[]).map((c) => c.name);
    expect(modelCols).toEqual(
      expect.arrayContaining([
        'id', 'title', 'description', 'category_id', 'tags_json', 'owner_id', 'visibility',
        'cover_asset_id', 'source_url', 'source_site', 'source_author', 'license',
        'source_folder_id', 'created_at', 'updated_at', 'deleted_at',
      ]),
    );

    const modelFileCols = (db.prepare('PRAGMA table_info(model_files)').all() as { name: string }[]).map((c) => c.name);
    expect(modelFileCols).toEqual(expect.arrayContaining(['model_id', 'asset_id', 'role', 'sort_order', 'label']));

    const profileCols = (db.prepare('PRAGMA table_info(print_profiles)').all() as { name: string }[]).map((c) => c.name);
    expect(profileCols).toEqual(
      expect.arrayContaining([
        'id', 'model_id', 'name', 'printer', 'material', 'nozzle', 'layer_height',
        'infill', 'supports', 'notes', 'settings_json', 'sliced_asset_id', 'sort_order', 'created_at',
      ]),
    );
  });

  it('the users.role CHECK is gone — inserting role=\'member\' succeeds on a fresh DB', () => {
    const db = makeDb();
    runMigrations(db);
    expect(() => {
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'newmember', 'hash', 'member')",
      ).run();
    }).not.toThrow();
    const row = db.prepare('SELECT role, display_name, disabled FROM users WHERE id = ?').get('u1') as {
      role: string; display_name: string | null; disabled: number;
    };
    expect(row.role).toBe('member');
    expect(row.display_name).toBeNull();
    expect(row.disabled).toBe(0);
  });

  it('seeds no categories on its own — seedCategoriesIfEmpty is a separate, explicit step (not part of the migration)', () => {
    const db = makeDb();
    runMigrations(db);
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number };
    expect(c).toBe(0);
  });
});

describe('MIGRATIONS: v14-shaped user survives the v15 table-copy', () => {
  it('preserves id/username/password_hash/role/created_at/updated_at, and backfills display_name=NULL, disabled=0', () => {
    const db = makeDb();

    // Bring the DB to exactly v14 first — the real v1..v14 strings,
    // stopping one migration short of the table-copy under test.
    runMigrations(db, MIGRATIONS.slice(0, 14));
    expect(db.pragma('user_version', { simple: true })).toBe(14);

    // Insert a user shaped exactly like the v13/v14 schema would allow
    // — this INSERT would throw right now if the CHECK(role IN
    // ('admin')) were somehow already gone at v14, which would mean
    // this test isn't actually exercising the v13 shape it claims to.
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES ('legacy-admin', 'aaron', 'scrypt:hash', 'admin', 1700000000, 1700000000)",
    ).run();
    expect(() => {
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES ('bad', 'x', 'y', 'member')",
      ).run();
    }).toThrow(); // proves the v14 CHECK is still active pre-copy

    // Now continue to v15 with the full real array.
    runMigrations(db, MIGRATIONS);
    expect(db.pragma('user_version', { simple: true })).toBe(15);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get('legacy-admin') as {
      id: string; username: string; password_hash: string; role: string;
      display_name: string | null; disabled: number; created_at: number; updated_at: number;
    };
    expect(row).toBeTruthy();
    expect(row.username).toBe('aaron');
    expect(row.password_hash).toBe('scrypt:hash');
    expect(row.role).toBe('admin'); // preserved, not reset to the new DEFAULT 'member'
    expect(row.display_name).toBeNull();
    expect(row.disabled).toBe(0);
    expect(row.created_at).toBe(1700000000);
    expect(row.updated_at).toBe(1700000000);

    // And the whole point of the copy: a 'member' insert is now allowed.
    expect(() => {
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES ('new-member', 'precia', 'scrypt:hash2', 'member')",
      ).run();
    }).not.toThrow();
  });

  it('exactly one users row survives the copy when only one existed at v14', () => {
    const db = makeDb();
    runMigrations(db, MIGRATIONS.slice(0, 14));
    db.prepare(
      "INSERT INTO users (id, username, password_hash) VALUES ('u1', 'admin', 'h')",
    ).run(); // role defaults to 'admin' per the v13 CHECK's DEFAULT
    runMigrations(db, MIGRATIONS);
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    expect(c).toBe(1);
  });
});
