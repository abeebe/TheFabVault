import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import type Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);

export const MOUNT_BASE = '/imports';
export const MOUNT_SLOTS = [1, 2, 3] as const;
export type MountSlot = 1 | 2 | 3;

export interface MountConfig {
  id: string;
  slot: MountSlot;
  name: string;
  type: 'nfs' | 'smb';
  host: string;
  remote_path: string;
  username?: string | null;
  password?: string | null;
  mount_opts?: string | null;
  enabled: number;
  role: 'import' | 'library';
  created_at: number;
  updated_at: number;
}

export interface MountConfigOut extends MountConfig {
  mountPoint: string;
  mounted: boolean;
}

/** Container-internal path for a given slot */
export function getMountPoint(slot: number): string {
  return `${MOUNT_BASE}/${slot}`;
}

/** Ensure /imports/1, /imports/2, /imports/3 exist */
export function ensureMountPoints(): void {
  for (const slot of MOUNT_SLOTS) {
    const mp = getMountPoint(slot);
    if (!fs.existsSync(mp)) {
      fs.mkdirSync(mp, { recursive: true });
    }
  }
}

/**
 * Check whether a given mount point is currently mounted
 * by reading /proc/mounts (reliable inside containers).
 */
export function isMounted(slot: number): boolean {
  const mp = getMountPoint(slot);
  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    return mounts.split('\n').some((line) => {
      const parts = line.split(' ');
      return parts[1] === mp;
    });
  } catch {
    return false;
  }
}

/** Returns { slot → mounted } status for all 3 slots */
export function getMountStatus(): Record<MountSlot, boolean> {
  return {
    1: isMounted(1),
    2: isMounted(2),
    3: isMounted(3),
  };
}

/** Mount a share based on its stored config */
export async function mountShare(config: MountConfig): Promise<void> {
  const mp = getMountPoint(config.slot);
  const isLibrary = config.role === 'library';

  if (config.type === 'nfs') {
    const extraOpts = config.mount_opts ? `,${config.mount_opts}` : '';
    const accessOpt = isLibrary ? 'rw' : 'ro';
    await execFileAsync('mount', [
      '-t', 'nfs4',
      `${config.host}:${config.remote_path}`,
      mp,
      '-o', `${accessOpt},soft,timeo=30,retrans=3${extraOpts}`,
    ]);
  } else if (config.type === 'smb') {
    const accessOpt = isLibrary ? 'rw' : 'ro';
    const opts = [
      accessOpt,
      `username=${config.username ?? 'guest'}`,
      `password=${config.password ?? ''}`,
      'vers=3.0',
      'iocharset=utf8',
      config.mount_opts ?? '',
    ].filter(Boolean).join(',');
    await execFileAsync('mount', [
      '-t', 'cifs',
      `//${config.host}/${config.remote_path}`,
      mp,
      '-o', opts,
    ]);
  } else {
    throw new Error(`Unknown mount type: ${(config as any).type}`);
  }
}

/** Lazy unmount a slot (umount -l so it won't block if busy) */
export async function unmountShare(slot: number): Promise<void> {
  const mp = getMountPoint(slot);
  await execFileAsync('umount', ['-l', mp]);
}

/**
 * On startup: re-mount all enabled mount configs.
 * Called after DB is initialized.
 */
export async function remountAll(db: Database.Database): Promise<void> {
  const configs = db
    .prepare('SELECT * FROM mount_configs WHERE enabled = 1 ORDER BY slot')
    .all() as MountConfig[];

  for (const cfg of configs) {
    try {
      if (isMounted(cfg.slot)) {
        console.log(`[mounts] Slot ${cfg.slot} already mounted (${cfg.name})`);
        continue;
      }
      await mountShare(cfg);
      console.log(`[mounts] Mounted slot ${cfg.slot}: ${cfg.name} (${cfg.type}://${cfg.host})`);
    } catch (err) {
      console.error(`[mounts] Failed to mount slot ${cfg.slot} (${cfg.name}):`, err);
    }
  }
}

/**
 * Returns container paths for all import-role slots that are currently mounted.
 * Library-role slots are excluded — they serve as storage, not scan sources.
 */
export function getActiveMountPaths(db?: Database.Database): string[] {
  if (!db) {
    // No DB context: return all mounted paths (legacy / safe fallback)
    return MOUNT_SLOTS.filter((s) => isMounted(s)).map((s) => getMountPoint(s));
  }
  const configs = db
    .prepare("SELECT slot, role FROM mount_configs WHERE enabled = 1 AND role = 'import'")
    .all() as { slot: MountSlot; role: string }[];
  return configs
    .filter((c) => isMounted(c.slot))
    .map((c) => getMountPoint(c.slot));
}

/**
 * If a library-role mount is configured and currently mounted,
 * returns its container path; otherwise returns null.
 */
export function getLibraryMountPath(db: Database.Database): string | null {
  const cfg = db
    .prepare("SELECT slot FROM mount_configs WHERE enabled = 1 AND role = 'library' LIMIT 1")
    .get() as { slot: MountSlot } | undefined;
  if (!cfg) return null;
  return isMounted(cfg.slot) ? getMountPoint(cfg.slot) : null;
}
