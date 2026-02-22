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
