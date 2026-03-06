import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';

let _db: Database.Database | null = null;

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
];

function runMigrations(db: Database.Database): void {
  const version = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.pragma(`user_version = ${i + 1}`);
    console.log(`[db] Applied migration ${i + 1}`);
  }
}

export function getDb(): Database.Database {
  if (!_db) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const dbPath = path.join(config.dataDir, 'thefabricatorsvault.db');
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    runMigrations(_db);
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
