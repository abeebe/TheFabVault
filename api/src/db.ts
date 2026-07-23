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
  // v15: "Local MakerWorld" restructure foundations (Phase A, #2154).
  // See Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md.
  //
  // users table-copy: the only safe SQLite pattern for dropping/altering
  // a CHECK constraint (SQLite has no ALTER ... DROP CONSTRAINT). This
  // drops the v13 `role CHECK(role IN ('admin'))` so multi-user
  // (Phase D) doesn't need a second breaking migration later. Verified
  // FK-safe before writing this: grepping every migration string v1–v14
  // above for `REFERENCES users` / `users(` turns up nothing — no table
  // references `users` yet, so DROP TABLE users (with foreign_keys=ON)
  // cannot orphan a child row. That stops being true the moment
  // `models.owner_id` is created a few statements below, which is
  // exactly why the copy happens FIRST, in this same migration, before
  // anything is given the chance to point at it.
  //
  // role keeps its existing per-row value for every copied user (an
  // existing admin stays 'admin' — only the DEFAULT for new rows
  // becomes 'member'). No CHECK on the new role column: valid values
  // are enforced by services/enumValidators.ts (USER_ROLES) instead —
  // this migration's whole reason for existing is to not repeat v13's
  // CHECK mistake on the very column it's fixing.
  `
  CREATE TABLE users_new (
    id            TEXT    PRIMARY KEY,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'member',
    display_name  TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
  INSERT INTO users_new (id, username, password_hash, role, display_name, disabled, created_at, updated_at)
    SELECT id, username, password_hash, role, NULL, 0, created_at, updated_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;

  -- Curated category tree (self-referential parent_id, same nesting
  -- pattern as folders.parent_id / sub_assemblies.parent_id). Seeded by
  -- seedCategoriesIfEmpty() below, alongside seedAdminIfNeeded.
  CREATE TABLE IF NOT EXISTS categories (
    id         TEXT    PRIMARY KEY,
    name       TEXT    NOT NULL,
    parent_id  TEXT    REFERENCES categories(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

  -- The new model-centric core unit. Models reference existing assets
  -- via the model_files join table below — assets stay the untouched
  -- file substrate, a model doesn't own its files, it links them.
  -- visibility is a two-value TEXT enum (public/private, no CHECK —
  -- see enumValidators.ts) enforced at the query layer once
  -- services/visibility.ts lands in Phase B; single-user today, so
  -- every existing/new model defaults to 'public' with no behavior
  -- change yet.
  CREATE TABLE IF NOT EXISTS models (
    id               TEXT    PRIMARY KEY,
    title            TEXT    NOT NULL,
    description      TEXT,
    category_id      TEXT    REFERENCES categories(id) ON DELETE SET NULL,
    tags_json        TEXT    NOT NULL DEFAULT '[]',
    owner_id         TEXT    REFERENCES users(id) ON DELETE SET NULL,
    visibility       TEXT    NOT NULL DEFAULT 'public',
    cover_asset_id   TEXT    REFERENCES assets(id) ON DELETE SET NULL,
    source_url       TEXT,
    source_site      TEXT,
    source_author    TEXT,
    license          TEXT,
    source_folder_id TEXT    REFERENCES folders(id) ON DELETE SET NULL,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at       INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted_at       INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_models_owner    ON models(owner_id);
  CREATE INDEX IF NOT EXISTS idx_models_category ON models(category_id);
  CREATE INDEX IF NOT EXISTS idx_models_deleted  ON models(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_models_created  ON models(created_at DESC);

  -- Join table: which assets belong to which model, and in what role
  -- (part/image/doc/other — app-validated, see enumValidators.ts). One
  -- asset can belong to multiple models. Gallery images are just assets
  -- with role='image', riding the existing thumbnail pipeline for free.
  CREATE TABLE IF NOT EXISTS model_files (
    model_id   TEXT    NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    asset_id   TEXT    NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL DEFAULT 'part',
    sort_order INTEGER NOT NULL DEFAULT 0,
    label      TEXT,
    PRIMARY KEY (model_id, asset_id)
  );
  CREATE INDEX IF NOT EXISTS idx_model_files_model ON model_files(model_id);
  CREATE INDEX IF NOT EXISTS idx_model_files_asset ON model_files(asset_id);

  -- Named slicer settings for a model (one model can have several —
  -- e.g. "PLA, 0.2mm" vs "PETG, 0.28mm"). sliced_asset_id optionally
  -- points at an already-sliced .gcode/.3mf asset for this profile,
  -- copying the sets.cover_asset_id ON DELETE SET NULL pattern (v11).
  CREATE TABLE IF NOT EXISTS print_profiles (
    id              TEXT    PRIMARY KEY,
    model_id        TEXT    NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    name            TEXT    NOT NULL,
    printer         TEXT,
    material        TEXT,
    nozzle          TEXT,
    layer_height    REAL,
    infill          INTEGER,
    supports        INTEGER NOT NULL DEFAULT 0,
    notes           TEXT,
    settings_json   TEXT    NOT NULL DEFAULT '{}',
    sliced_asset_id TEXT    REFERENCES assets(id) ON DELETE SET NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_print_profiles_model ON print_profiles(model_id);`,
  // v16: collections + likes (Phase B, #2167). See
  // Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md
  // §"Schema (sketches)" v16.
  //
  // collections is the model-level analog of sets (v11): name,
  // description, optional cover, and a membership list — except a
  // collection's members are models (collection_models), not assets.
  // Same owner_id/visibility shape as models (v15): visibility is a
  // bare TEXT with no CHECK (enumValidators.ts's isModelVisibility is
  // reused — same two values, 'public'/'private', no reason to fork a
  // second identical enum) and enforcement is deferred to Phase D3's
  // visibility.ts threading, same as models today. cover_model_id
  // mirrors models.cover_asset_id's ON DELETE SET NULL pattern.
  //
  // model_likes is a pure join table: PK (model_id, user_id) makes
  // "like" and "unlike" idempotent by construction (INSERT OR IGNORE /
  // DELETE, no separate existence check needed) rather than a boolean
  // column on a per-user row. CASCADE both directions: deleting a model
  // clears its likes, deleting a user clears their likes — neither
  // cascade ever touches models/assets rows themselves.
  //
  // idx_collection_models_model and idx_model_likes_user (not the PK's
  // leading column, which SQLite already indexes for free via the
  // table's own rowid/PK btree) are the two lookup directions the
  // routes actually need: "which collections is this model in" and
  // "which models has this user liked" / "has this user liked model X"
  // are both keyed off the PK's second column, which has no index of
  // its own without these.
  `
  CREATE TABLE IF NOT EXISTS collections (
    id             TEXT    PRIMARY KEY,
    name           TEXT    NOT NULL,
    description    TEXT,
    owner_id       TEXT    REFERENCES users(id) ON DELETE SET NULL,
    visibility     TEXT    NOT NULL DEFAULT 'public',
    cover_model_id TEXT    REFERENCES models(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS collection_models (
    collection_id TEXT    NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    model_id      TEXT    NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    added_at      INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (collection_id, model_id)
  );
  CREATE INDEX IF NOT EXISTS idx_collection_models_model ON collection_models(model_id);

  CREATE TABLE IF NOT EXISTS model_likes (
    model_id   TEXT    NOT NULL REFERENCES models(id) ON DELETE CASCADE,
    user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (model_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_model_likes_user ON model_likes(user_id);`,
  // v17: token_version — closes #2185 (stateless {sub} JWTs meant a
  // password reset never invalidated tokens already issued: the old
  // token still verified fine against the JWT secret and still matched
  // a live, non-disabled users row, right up until its own TTL expired
  // naturally). A plain ADD COLUMN, not a v15-style table-copy — unlike
  // v13's `role CHECK(role IN ('admin'))`, there is no CHECK constraint
  // on this column to drop, so SQLite's normal ALTER TABLE ADD COLUMN
  // (with a literal DEFAULT) applies to every existing row in place.
  //
  // ADDITIVE claim, not a replacement for {sub}: auth.ts's createToken
  // now signs { sub, tv: tokenVersion } instead of { sub } alone, but
  // role/id/disabled/display_name are still read from the live `users`
  // row on every request exactly as before (auth.ts's own header
  // comment on why role/disabled were deliberately kept out of the
  // token still holds) — token_version is the only thing that rides in
  // the token now. requireAuth/requireAdmin compare the token's claim
  // against the live row's current value and 401 on any mismatch,
  // treating a token with no `tv` claim at all (anything minted before
  // this migration, up to config.jwtTtl seconds old) as version 1 — the
  // same value this column's DEFAULT gives every existing row — so a
  // deploy doesn't force-logout every already-signed-in session, while
  // a password reset (routes/users.ts's POST /users/:id/reset-password,
  // the only reset-password route in this app) still bumps the live
  // row's token_version and immediately invalidates every token minted
  // before that bump, old-format or new.
  `ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;`,
];

/**
 * Applies MIGRATIONS[version..] in order, each in its own transaction.
 *
 * Previously (`db.exec(MIGRATIONS[i])` then a separate `db.pragma`
 * call, no transaction at all) a migration that failed partway through
 * a multi-statement string — or the process dying between the exec and
 * the user_version bump — could leave the schema half-applied while
 * user_version still reported the OLD version. On next boot that
 * looks identical to "never ran," so runMigrations would replay the
 * same migration string against a DB that already has some of its
 * tables/columns, which fails loudly or (worse, for a plain
 * `ALTER TABLE ... ADD COLUMN` with no IF-NOT-EXISTS guard) is a
 * migration that can never move forward again.
 *
 * Wrapping each migration's exec + version bump in one
 * `db.transaction()` (immediate-mode: acquires the write lock at BEGIN
 * rather than on first write, so this can't hit a mid-migration lock
 * upgrade failure) makes each one atomic: SQLite DDL is fully
 * transactional, and PRAGMA user_version is itself part of the
 * transaction it's set in (rolled back along with everything else on
 * failure). Either the whole migration's schema change AND the version
 * bump land together, or neither does — user_version and schema always
 * agree, and a failed migration leaves the DB byte-for-byte as it was
 * before this call, ready to retry (after a fix) on the next boot.
 *
 * `migrations` defaults to the real, immutable MIGRATIONS array — it's
 * a parameter only so tests can pass a synthetic array (see
 * __tests__/migrations.test.ts) without ever touching production SQL.
 */
export function runMigrations(db: Database.Database, migrations: string[] = MIGRATIONS): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (let i = version; i < migrations.length; i++) {
    const migrationNum = i + 1;
    const applyMigration = db.transaction(() => {
      db.exec(migrations[i]);
      db.pragma(`user_version = ${migrationNum}`);
    });
    try {
      applyMigration.immediate();
    } catch (err) {
      console.error(
        `[db] Migration ${migrationNum} failed and was rolled back — user_version remains ${i}, schema unchanged:`,
        err,
      );
      throw err;
    }
    console.log(`[db] Applied migration ${migrationNum}`);
  }
}

export { MIGRATIONS };

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
      // role is explicit here, not left to the column DEFAULT: as of
      // migration v15 the `users` table's default role is 'member' (new
      // signups, once Phase D adds them, aren't admins by default) — the
      // very first, env-seeded user must still land as 'admin' or no one
      // can ever reach requireAdmin-gated routes (mounts config, etc.).
      db.prepare(
        "INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, 'admin')"
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
 * One-time seed of the curated category tree, only when `categories` is
 * empty — same idempotency shape as seedAdminIfNeeded: once any row
 * exists (including ones Aaron renamed/reordered/deleted by hand), this
 * is a permanent no-op and the DB is the source of truth. Top-level only
 * (parent_id NULL); sub-categories, if any are ever wanted, are a manual
 * follow-up, not something this seed grows into on its own.
 */
const DEFAULT_CATEGORIES = [
  'Functional',
  'Toys & Games',
  'Props & Cosplay',
  'Household',
  'Tools',
  'Decor',
  'Miniatures',
  'Signage/2D',
];

function seedCategoriesIfEmpty(db: Database.Database): void {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number };
  if (c > 0) return; // DB already has categories — it is the source of truth

  const insert = db.prepare(
    'INSERT INTO categories (id, name, parent_id, sort_order) VALUES (?, ?, NULL, ?)'
  );
  const seedAll = db.transaction((names: string[]) => {
    names.forEach((name, i) => insert.run(uuidv4(), name, i));
  });
  seedAll(DEFAULT_CATEGORIES);
  console.log(`[db] Seeded ${DEFAULT_CATEGORIES.length} default categories.`);
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
    seedCategoriesIfEmpty(db);
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
