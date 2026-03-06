import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAdmin } from '../auth.js';
import { getDb } from '../db.js';
import {
  mountShare,
  unmountShare,
  isMounted,
  getMountStatus,
  getMountPoint,
  type MountConfig,
  type MountSlot,
} from '../services/mountManager.js';

const router = Router();

// ─── GET /admin/mounts ───────────────────────────────────────────────────────
// Returns all 3 slots (configured or not) with live mount status
router.get('/admin/mounts', requireAdmin, (_req: Request, res: Response) => {
  try {
    const db = getDb();
    const configs = db
      .prepare('SELECT * FROM mount_configs ORDER BY slot')
      .all() as MountConfig[];
    const status = getMountStatus();

    // Build a map of slot → config for easy lookup
    const bySlot: Record<number, MountConfig> = {};
    for (const c of configs) bySlot[c.slot] = c;

    // Return status for all 3 slots (including unconfigured ones)
    const slots = ([1, 2, 3] as MountSlot[]).map((slot) => {
      const cfg = bySlot[slot] ?? null;
      return {
        slot,
        mountPoint: getMountPoint(slot),
        mounted: status[slot] ?? false,
        config: cfg,
      };
    });

    res.json(slots);
  } catch (err) {
    console.error('[mounts] GET /admin/mounts:', err);
    res.status(500).json({ error: 'Failed to list mount configs' });
  }
});

// ─── POST /admin/mounts ──────────────────────────────────────────────────────
// Create or update mount config for a slot
router.post('/admin/mounts', requireAdmin, async (req: Request, res: Response) => {
  const { slot, name, type, host, remote_path, username, password, mount_opts, enabled, role } =
    req.body as {
      slot?: number; name?: string; type?: string; host?: string; remote_path?: string;
      username?: string; password?: string; mount_opts?: string; enabled?: boolean | number;
      role?: string;
    };

  if (!slot || !name || !type || !host || !remote_path) {
    res.status(400).json({ error: 'slot, name, type, host, and remote_path are required' });
    return;
  }
  if (![1, 2, 3].includes(slot)) {
    res.status(400).json({ error: 'slot must be 1, 2, or 3' });
    return;
  }
  if (!['nfs', 'smb'].includes(type)) {
    res.status(400).json({ error: "type must be 'nfs' or 'smb'" });
    return;
  }
  const roleVal = role === 'library' ? 'library' : 'import';

  try {
    const db = getDb();
    const existing = db
      .prepare('SELECT id FROM mount_configs WHERE slot = ?')
      .get(slot) as { id: string } | undefined;

    const enabledVal = enabled === false || enabled === 0 ? 0 : 1;

    // Unmount if currently mounted (config is changing)
    if (isMounted(slot)) {
      try {
        await unmountShare(slot);
      } catch (err) {
        console.warn(`[mounts] Could not unmount slot ${slot} before config update:`, err);
      }
    }

    // If this slot is becoming the library, clear any other slot's library role first
    if (roleVal === 'library') {
      db.prepare(`
        UPDATE mount_configs SET role = 'import', updated_at = unixepoch()
        WHERE role = 'library' AND slot != ?
      `).run(slot);
    }

    if (existing) {
      db.prepare(`
        UPDATE mount_configs
        SET name = ?, type = ?, host = ?, remote_path = ?,
            username = ?, password = ?, mount_opts = ?, enabled = ?, role = ?,
            updated_at = unixepoch()
        WHERE slot = ?
      `).run(
        name, type, host, remote_path,
        username ?? null, password ?? null, mount_opts ?? null, enabledVal, roleVal,
        slot,
      );
    } else {
      const id = uuidv4();
      db.prepare(`
        INSERT INTO mount_configs
          (id, slot, name, type, host, remote_path, username, password, mount_opts, enabled, role)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, slot, name, type, host, remote_path,
        username ?? null, password ?? null, mount_opts ?? null, enabledVal, roleVal,
      );
    }

    // If role is library, update system_config.storageDir to the mount point
    if (roleVal === 'library') {
      const mountPoint = getMountPoint(slot);
      db.prepare(`
        INSERT INTO system_config (key, value, updated_at)
        VALUES ('storageDir', ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
      `).run(mountPoint);
      console.log(`[mounts] Library slot ${slot} set — storageDir → ${mountPoint}`);
    } else if (roleVal === 'import') {
      // If this slot was previously the library, revert storageDir to default
      const prev = db
        .prepare("SELECT value FROM system_config WHERE key = 'storageDir'")
        .get() as { value: string } | undefined;
      if (prev?.value === getMountPoint(slot)) {
        db.prepare(`
          INSERT INTO system_config (key, value, updated_at)
          VALUES ('storageDir', ?, unixepoch())
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
        `).run(process.env.STORAGE_DIR ?? '/app/storage');
        console.log(`[mounts] Slot ${slot} demoted from library — storageDir reverted to default`);
      }
    }

    const resultId = existing?.id ?? db.prepare('SELECT id FROM mount_configs WHERE slot = ?').get(slot) as { id: string };
    res.json({ success: true, id: typeof resultId === 'string' ? resultId : (resultId as any).id });
  } catch (err) {
    console.error('[mounts] POST /admin/mounts:', err);
    res.status(500).json({ error: 'Failed to save mount config' });
  }
});

// ─── DELETE /admin/mounts/:slot ──────────────────────────────────────────────
router.delete('/admin/mounts/:slot', requireAdmin, async (req: Request, res: Response) => {
  const slot = parseInt(req.params.slot, 10);
  if (![1, 2, 3].includes(slot)) {
    res.status(400).json({ error: 'slot must be 1, 2, or 3' });
    return;
  }

  try {
    if (isMounted(slot)) {
      await unmountShare(slot);
    }
  } catch (err) {
    console.warn(`[mounts] Could not unmount slot ${slot} before delete:`, err);
  }

  try {
    const db = getDb();
    // If this was the library, revert storageDir to default before deleting
    const cfg = db
      .prepare("SELECT role FROM mount_configs WHERE slot = ?")
      .get(slot) as { role: string } | undefined;
    if (cfg?.role === 'library') {
      db.prepare(`
        INSERT INTO system_config (key, value, updated_at)
        VALUES ('storageDir', ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
      `).run(process.env.STORAGE_DIR ?? '/app/storage');
      console.log(`[mounts] Library slot ${slot} deleted — storageDir reverted to default`);
    }
    db.prepare('DELETE FROM mount_configs WHERE slot = ?').run(slot);
    res.json({ success: true });
  } catch (err) {
    console.error('[mounts] DELETE /admin/mounts/:slot:', err);
    res.status(500).json({ error: 'Failed to delete mount config' });
  }
});

// ─── POST /admin/mounts/:slot/mount ──────────────────────────────────────────
router.post('/admin/mounts/:slot/mount', requireAdmin, async (req: Request, res: Response) => {
  const slot = parseInt(req.params.slot, 10);
  const db = getDb();
  const config = db
    .prepare('SELECT * FROM mount_configs WHERE slot = ?')
    .get(slot) as MountConfig | undefined;

  if (!config) {
    res.status(404).json({ error: 'No mount config found for this slot' });
    return;
  }

  try {
    if (isMounted(slot)) {
      res.json({ success: true, mounted: true, message: 'Already mounted' });
      return;
    }
    await mountShare(config);
    console.log(`[mounts] Manually mounted slot ${slot}: ${config.name}`);
    res.json({ success: true, mounted: true });
  } catch (err: any) {
    console.error(`[mounts] Mount failed for slot ${slot}:`, err);
    res.status(500).json({ error: err.message ?? 'Mount failed' });
  }
});

// ─── POST /admin/mounts/:slot/unmount ────────────────────────────────────────
router.post('/admin/mounts/:slot/unmount', requireAdmin, async (req: Request, res: Response) => {
  const slot = parseInt(req.params.slot, 10);

  try {
    if (!isMounted(slot)) {
      res.json({ success: true, mounted: false, message: 'Not currently mounted' });
      return;
    }
    await unmountShare(slot);
    console.log(`[mounts] Manually unmounted slot ${slot}`);
    res.json({ success: true, mounted: false });
  } catch (err: any) {
    console.error(`[mounts] Unmount failed for slot ${slot}:`, err);
    res.status(500).json({ error: err.message ?? 'Unmount failed' });
  }
});

export default router;
