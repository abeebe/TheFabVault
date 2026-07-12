import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { hashPassword } from './passwords.js';
import type { UserRow } from './types/index.js';

let _db: Database.Database | null = null;
let _jwtSecret: string | null = null;

const MIGRATIONS: string[] = [
  // v1: full initial schema
  `
  CREATE TABLE IF NOT EXISTS folders (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL,
    parent_id   TEXT    REFERENCES folders(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS assets (
    id            TEXT    PRIMARY KEY,
    filename      TEXT    NOT NULL,
    original_name TEXT,
    mime          TEXT    NOT NULL DEFAULT 'application/octet-stream',
    size          INTEGER NOT NULL DEFAULT 0,
    folder_id     TEXT    REFERENCES folders(id) ON DELETE SET NULL,
    tags_json     TEXT    NOT NULL DEFAULT '[]',
    notes         TEXT,
    source_path   TEXT,
    thumb_status  TEXT    NOT NULL DEFAULT 'none'
                          CHECK(thumb_status IN ('none','pending','done','failed')),
    meta_json     TEXT    NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS projects (
    id                    TEXT    PRIMARY KEY,
    name                  TEXT    NOT NULL,
    description           TEXT,
    folder_id             TEXT    REFERENCES folders(id) ON DELETE SET NULL,
    tags_json             TEXT    NOT NULL DEFAULT '[]',
    printer_settings_json TEXT    NOT NULL DEFAULT '{}',
    laser_settings_json   TEXT    NOT NULL DEFAULT '{}',
    vinyl_settings_json   TEXT    NOT NULL DEFAULT '{}',
    created_at            INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS project_assets (
    project_id    TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    asset_id      TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    overrides_json TEXT   NOT NULL DEFAULT '{}',
    PRIMARY KEY (project_id, asset_id)
  );

  CREATE INDEX IF NOT EXISTS idx_assets_folder      ON assets(folder_id);
  CREATE INDEX IF NOT EXISTS idx_assets_created     ON assets(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_assets_source      ON assets(source_path);
  CREATE INDEX IF NOT EXISTS idx_projects_folder    ON projects(folder_id);
  CREATE INDEX IF NOT EXISTS idx_project_assets_proj ON project_assets(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_assets_asset ON project_assets(asset_id);
  `,
  // v2: add system config table for runtime configuration
  `
  CREATE TABLE IF NOT EXISTS system_config (
    key       TEXT    PRIMARY KEY,
    value     TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  `,
  // v3: user-overridable category column on assets
  `ALTER TABLE assets ADD COLUMN category TEXT;`,
  // v4: network mount configurations (NFS/SMB shares managed by the app)
  `
  CREATE TABLE IF NOT EXISTS mount_configs (
    id          TEXT    PRIMARY KEY,
    slot        INTEGER NOT NULL UNIQUE CHECK(slot IN (1, 2, 3)),
    name        TEXT    NOT NULL,
    type        TEXT    NOT NULL CHECK(type IN ('nfs', 'smb')),
    host        TEXT    NOT NULL,
    remote_path TEXT    NOT NULL,
    username    TEXT,
    password    TEXT,
    mount_opts  TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );
  `,
  // v5: role column — 'import' (read-only scan source) or 'library' (read-write primary storage)
  `ALTER TABLE mount_configs ADD COLUMN role TEXT NOT NULL DEFAULT 'import'
   CHECK(role IN ('import', 'library'));`,
  // v6: SHA-256 content hash for duplicate detection
  `ALTER TABLE assets ADD COLUMN file_hash TEXT;
   CREATE INDEX IF NOT EXISTS idx_assets_file_hash ON assets(file_hash);`,
  // v7: soft-delete / trash (NULL = active, unix timestamp = trashed)
  `ALTER TABLE assets ADD COLUMN deleted_at INTEGER;
   CREATE INDEX IF NOT EXISTS idx_assets_deleted ON assets(deleted_at);`,
  // v8: star rating (NULL = unrated, 1–5)
  `ALTER TABLE assets ADD COLUMN rating INTEGER;`,
  // v9: version history — each row is a previous version of an asset file
  `CREATE TABLE IF NOT EXISTS asset_versions (
    id          TEXT    PRIMARY KEY,
    asset_id    TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    version_num INTEGER NOT NULL,
    filename    TEXT    NOT NULL,
    size        INTEGER NOT NULL DEFAULT 0,
    file_hash   TEXT,
    notes       TEXT,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(asset_id, version_num)
  );
  CREATE INDEX IF NOT EXISTS idx_asset_versions_asset ON asset_versions(asset_id);`,
  // v10: favorites (0 = normal, 1 = favorited)
  `ALTER TABLE assets ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS idx_assets_favorite ON assets(is_favorite);`,
  // v11: sets — lightweight grouping primitive distinct from folders
  // (no file location) and projects (no active-work scaffolding).
  // A file can belong to many sets; sets carry just name/description
  // and an optional cover asset.
  `CREATE TABLE IF NOT EXISTS sets (
     id             TEXT    PRIMARY KEY,
     name           TEXT    NOT NULL,
     description    TEXT,
     cover_asset_id TEXT    REFERENCES assets(id) ON DELETE SET NULL,
     created_at     INTEGER NOT NULL DEFAULT (unixepoch())
   );
   CREATE TABLE IF NOT EXISTS set_assets (
     set_id     TEXT    NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
     asset_id   TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
     sort_order INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (set_id, asset_id)
   );
   CREATE INDEX IF NOT EXISTS idx_set_assets_set ON set_assets(set_id);
   CREATE INDEX IF NOT EXISTS idx_set_assets_asset ON set_assets(asset_id);`,
  // v12: sub-assemblies. Hierarchical build-manifest breakdown for a
  // project (R2D2 -> Right Foot -> parts). Self-referential parent_id
  // gives infinite nesting, same pattern as folders.parent_id.
  `CREATE TABLE IF NOT EXISTS sub_assemblies (
    id         TEXT    PRIMARY KEY,
    project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    parent_id  TEXT    REFERENCES sub_assemblies(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- A "part" is a placement of one asset inside one sub-assembly. It is
  -- not a copy of the file (asset_id points at the one row in assets).
  -- quantity = physical prints this placement needs. printed_count =
  -- how many of those are done. Progress is tracked per placement, not
  -- per asset — two placements of the same shared asset in two different
  -- sub-assemblies are two independent counters.
  CREATE TABLE IF NOT EXISTS sub_assembly_parts (
    sub_assembly_id TEXT    NOT NULL REFERENCES sub_assemblies(id) ON DELETE CASCADE,
    asset_id        TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    quantity        INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
    printed_count   INTEGER NOT NULL DEFAULT 0 CHECK(printed_count >= 0),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    overrides_json  TEXT    NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (sub_assembly_id, asset_id)
  );

  CREATE INDEX IF NOT EXISTS idx_sub_assemblies_project    ON sub_assemblies(project_id);
  CREATE INDEX IF NOT EXISTS idx_sub_assemblies_parent     ON sub_assemblies(parent_id);
  CREATE INDEX IF NOT EXISTS idx_sub_assembly_parts_sa     ON sub_assembly_parts(sub_assembly_id);
  CREATE INDEX IF NOT EXISTS idx_sub_assembly_parts_asset  ON sub_assembly_parts(asset_id);`,
  // v13: admin users — env-to-DB auth migration. Moves AUTH_USERNAME/
  // AUTH_PASSWORD off the stack env (a Portainer redeploy wiping the
  // `environment:` block previously caused a fail-OPEN state — see
  // Reports/kit-fabvault-env-to-db-auth-scoping-2026-07-08.md §0 and
  // Reports/vera-fabvault-auth-migration-security-review-2026-07-08.md).
  // `role` is CHECK-constrained to a single value today (this app has
  // one admin, no multi-user concept elsewhere in the schema) so a
  // future multi-user pass doesn't need a breaking migration — no
  // users-list UI, invite flow, or RBAC is being added in this pass.
  `CREATE TABLE IF NOT EXISTS users (
    id            TEXT    PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'admin' CHECK(role IN ('admin')),
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );`,
  // v14: source_mtime_ms — filesystem mtime (ms since epoch) observed the
  // last time a mount-scan reconciled this asset against its source_path.
  // NULL for assets with no source_path (plain upload/drag-drop/folder
  // import) and, once, for every pre-existing mount-imported asset until
  // its first post-migration scan establishes a baseline. Let
  // scanSingleMount() skip re-hashing a known path when the OS-reported
  // mtime hadn't moved since the last scan, instead of reading+hashing
  // every file on every pass (services/mountImport.ts; feasibility Q1,
  // Reports/sloane-prd-thefabvault-file-versioning-2026-07-11.md).
  //
  // Historical note (2026-07-12, #2078): the mount-scan subsystem that
  // wrote and read this column was removed entirely (self-import bug —
  // see Reports/holt-fabvault-*-2026-07-12.md). This column is now
  // unused/dead for every row going forward — left in place, NOT backed
  // out with a destructive migration; it's inert and harmless, and every
  // historical migration in this array stays immutable regardless.
  `ALTER TABLE assets ADD COLUMN source_mtime_ms INTEGER;`,
];

function runMigrations(db: Database.Database): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.pragma(`user_version = ${i + 1}`);
    console.log(`[db] Applied migration ${i + 1}`);
  }
}

// ─── Auth bootstrap (migration v13) ────────────────────────────────────────
//
// Runs once, synchronously, inside getDb() right after migrations — i.e.
// before the HTTP server's listen callback returns control to the event
// loop, so no request can be dispatched before this has completed.
//
// Deliberately NOT modeled on the getStorageDir() try/catch-fall-through
// pattern above: that pattern is correct for storageDir (worst case: wrong
// folder) and wrong for anything auth-shaped (worst case: wide open). Both
// functions below only ever produce two outcomes — succeed, or leave the
// state such that every protected route denies — never a silent bypass.

/**
 * One-time seed of the initial admin from env, only when `users` is
 * empty. Idempotent: once a row exists, the DB is the source of truth
 * and this is a no-op on every subsequent boot, regardless of what's in
 * AUTH_USERNAME/AUTH_PASSWORD env (they can be left in place — harmless
 * — or removed after the log line below confirms the seed happened).
 *
 * Never logs the seeded username or password — only that a seed did or
 * did not happen. (Kit's original scoping doc contradicted itself here:
 * §3's sample logged the username, §5.3 said never log it. Resolved:
 * never log it.)
 */
function seedAdminIfNeeded(db: Database.Database): void {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  if (c > 0) return; // DB already has an admin — it is the source of truth, env is ignored

  const envUser = process.env.AUTH_USERNAME;
  const envPass = process.env.AUTH_PASSWORD;
  if (envUser && envPass) {
    try {
      const hash = hashPassword(envPass);
      db.prepare(
        'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'
      ).run(uuidv4(), envUser, hash);
      console.log('[db] Seeded initial admin from env (one-time). DB is now the source of truth for auth.');
    } catch (err) {
      console.error('[db] Failed to seed initial admin from env — no admin exists, all protected routes will deny:', err);
    }
  } else {
    console.warn('[db] No admin user exists in the DB and AUTH_USERNAME/AUTH_PASSWORD are not set — no admin can log in and all protected routes will deny. Set both once to seed, then they can be left in place (ignored) or removed.');
  }
}

/**
 * Resolve the JWT signing secret and cache it in-memory for the life of
 * the process: (1) system_config.jwtSecret if present, (2) generate via
 * crypto.randomBytes(64) and persist if the DB has none, (3) hard
 * failure — throw, refuse to start — if neither is possible. There is
 * no literal-string fallback anywhere in this path (the old
 * `'changeme-replace-in-production'` default in config.ts is deleted,
 * not left alongside this as a leftover escape hatch).
 */
function resolveJwtSecret(db: Database.Database): string {
  const existing = db
    .prepare('SELECT value FROM system_config WHERE key = ?')
    .get('jwtSecret') as { value: string } | undefined;
  if (existing?.value) return existing.value;

  const generated = crypto.randomBytes(64).toString('hex');
  db.prepare(`
    INSERT INTO system_config (key, value, updated_at)
    VALUES ('jwtSecret', ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).run(generated);
  console.log('[db] Generated and persisted a new JWT signing secret (first boot).');
  return generated;
}

/** Throws if called before getDb() has run at least once (should never
 * happen in practice — getDb() resolves this synchronously on first
 * call, and every caller of getJwtSecret() goes through a route that
 * only runs after the server is already up). Never returns a literal
 * default. */
export function getJwtSecret(): string {
  getDb(); // ensures _jwtSecret is populated
  if (!_jwtSecret) {
    throw new Error('[db] JWT secret not resolved — DB not initialized');
  }
  return _jwtSecret;
}

/**
 * Fail-closed: true only when we can positively confirm at least one
 * admin row exists. Any DB read error resolves to false (treated as
 * "not configured"), never true. Used only for informational/UX
 * surfaces (health check, login's "not configured yet" response) — it
 * does NOT gate requireAuth/requireAdmin, which check token validity
 * against a live users row directly and have no bypass branch at all.
 */
export function adminExists(): boolean {
  try {
    const db = getDb();
    const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
    return c > 0;
  } catch (err) {
    console.error('[db] adminExists() DB read failed — treating as false (fail closed):', err);
    return false;
  }
}

/**
 * Fail-closed: any DB read error returns null (no match), same as a
 * genuine "no such user" — never throws out to a caller that might
 * treat an exception as "skip the check."
 */
export function getUserByUsername(username: string): UserRow | null {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined;
    return row ?? null;
  } catch (err) {
    console.error('[db] getUserByUsername() DB read failed — treating as no match (fail closed):', err);
    return null;
  }
}

export function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const dbPath = path.join(config.dataDir, 'thefabricatorsvault.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    _jwtSecret = resolveJwtSecret(db);
    seedAdminIfNeeded(db);
    _db = db;
    console.log(`[db] Connected: ${dbPath}`);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    try {
      // Checkpoint WAL to ensure all data is flushed to main db file
      _db.pragma('wal_checkpoint(TRUNCATE)');
      _db.close();
      console.log('[db] Database closed and WAL checkpointed');
    } catch (err) {
      console.error('[db] Error closing database:', err);
    }
    _db = null;
  }
}
