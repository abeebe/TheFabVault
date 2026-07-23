// Admin users CRUD (Phase D, #2177 — plan §6). Every route here is
// requireAdmin: this is account-management surface, not something a
// 'member' ever needs (their own identity/role comes from GET /auth/me
// instead, routes/auth.ts). There is deliberately no self-registration
// endpoint anywhere in the app — every account is admin-provisioned.
//
// No DELETE in v1: models.owner_id is `ON DELETE SET NULL` (db.ts v15),
// so deleting a user row would silently orphan their models to
// "no owner" with no confirmation step and no way back. Disabling
// (PATCH .../disabled) preserves owner_id integrity — the row (and every
// FK pointing at it) stays intact, the account just can't authenticate.
// A real delete, if ever wanted, is a separate future ticket with its own
// "what happens to this user's models" decision — not bundled in here.
//
// Self-lockout guards: an admin can never disable or demote (role away
// from 'admin') their OWN row via this route — 409, checked against
// req.user.id (the acting admin, attached by requireAdmin). Without this,
// the last admin could disable themselves and permanently lock the whole
// app (seedAdminIfNeeded only ever seeds once, when `users` is empty —
// disabling every admin isn't "empty", so it would never re-seed).

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAdmin } from '../auth.js';
import { getDb } from '../db.js';
import { generatePassword, hashPassword, MIN_PASSWORD_LENGTH } from '../passwords.js';
import { isUserRole } from '../services/enumValidators.js';
import type { UserOut, UserRow } from '../types/index.js';

const router = Router();

function toUserOut(row: UserRow): UserOut {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Every SQLite UNIQUE-violation error thrown by better-sqlite3 has this
// code — checked instead of string-matching err.message, which is not a
// stable contract across better-sqlite3 versions.
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

// GET /users — list every user (including disabled). requireAdmin: this
// is the only place disabled/role/timestamps for every account are
// visible at once.
router.get('/users', requireAdmin, (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM users ORDER BY username ASC').all() as UserRow[];
  res.json(rows.map(toUserOut));
});

// POST /users — create. username + role required (role defaults to
// 'member' — new accounts are never admin by default, mirroring the
// column's own DEFAULT in migration v15); password is either admin-
// supplied (>= MIN_PASSWORD_LENGTH) or generated. displayName optional.
//
// generatedPassword is present on the response ONLY when the admin did
// not supply one themselves — if they typed a password in, they already
// know it and echoing it back serves no purpose (and is one more place
// it could end up in a log/screenshot).
router.post('/users', requireAdmin, (req: Request, res: Response) => {
  const { username, password, role, displayName } = req.body as {
    username?: string;
    password?: string;
    role?: string;
    displayName?: string | null;
  };

  const trimmedUsername = username?.trim();
  if (!trimmedUsername) {
    res.status(400).json({ error: 'username is required' });
    return;
  }

  const resolvedRole = role ?? 'member';
  if (!isUserRole(resolvedRole)) {
    res.status(400).json({ error: `role must be one of: admin, member` });
    return;
  }

  const suppliedPassword = password?.trim();
  if (suppliedPassword && suppliedPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  const wasGenerated = !suppliedPassword;
  const plainPassword = suppliedPassword || generatePassword();
  const hash = hashPassword(plainPassword);

  const db = getDb();
  const id = uuidv4();
  try {
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, display_name, disabled)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(id, trimmedUsername, hash, resolvedRole, displayName?.trim() || null);
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'Username already taken' });
      return;
    }
    throw err;
  }

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  const body: UserOut & { generatedPassword?: string } = {
    ...toUserOut(row),
    ...(wasGenerated ? { generatedPassword: plainPassword } : {}),
  };
  res.status(201).json(body);
});

// POST /users/:id/reset-password — same admin-supplied-or-generated shape
// as create. No self-lockout concern here (unlike PATCH's disable/demote
// guard): an admin resetting their own password can't lock themselves
// out, they just get a new password back in the response.
//
// #2185 — also bumps token_version. Without this, resetting a password
// (e.g. because a token/session was suspected compromised, or the user
// just forgot theirs) left every ALREADY-ISSUED token for that account
// fully valid until its own TTL expired naturally (stateless {sub} JWTs
// have no server-side session to revoke) — the whole point of a reset in
// a "credentials may be compromised" scenario undermined by the old
// token still working. auth.ts's requireAuth/requireAdmin compare each
// token's `tv` claim (or the implicit 1 for a pre-v17 token) against the
// live row's token_version and 401 on any mismatch, so this UPDATE is
// what makes that comparison actually fail for every token minted before
// this reset, immediately, on their very next request.
router.post('/users/:id/reset-password', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const { password } = req.body as { password?: string };

  const db = getDb();
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const suppliedPassword = password?.trim();
  if (suppliedPassword && suppliedPassword.length < MIN_PASSWORD_LENGTH) {
    res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    return;
  }

  const wasGenerated = !suppliedPassword;
  const plainPassword = suppliedPassword || generatePassword();
  const hash = hashPassword(plainPassword);

  db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = unixepoch() WHERE id = ?').run(hash, id);

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  const body: UserOut & { generatedPassword?: string } = {
    ...toUserOut(row),
    ...(wasGenerated ? { generatedPassword: plainPassword } : {}),
  };
  res.json(body);
});

// PATCH /users/:id — role, displayName, disabled. Self-lockout guard: if
// :id === the acting admin's own id (req.user, attached by requireAdmin),
// reject (409) any attempt to disable themselves or change their own role
// away from 'admin' — see file header for why this matters (no other path
// back to a working admin account once every admin is locked out).
router.patch('/users/:id', requireAdmin, (req: Request, res: Response) => {
  const { id } = req.params;
  const { role, displayName, disabled } = req.body as {
    role?: string;
    displayName?: string | null;
    disabled?: boolean | number;
  };

  const db = getDb();
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!target) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const isSelf = req.user!.id === id;

  if (role !== undefined) {
    if (!isUserRole(role)) {
      res.status(400).json({ error: `role must be one of: admin, member` });
      return;
    }
    if (isSelf && role !== 'admin') {
      res.status(409).json({ error: 'You cannot demote your own account' });
      return;
    }
  }

  let disabledValue: 0 | 1 | undefined;
  if (disabled !== undefined) {
    disabledValue = disabled === true || disabled === 1 ? 1 : 0;
    if (isSelf && disabledValue === 1) {
      res.status(409).json({ error: 'You cannot disable your own account' });
      return;
    }
  }

  const newRole = role !== undefined ? role : target.role;
  const newDisplayName = displayName !== undefined ? (displayName?.trim() || null) : target.display_name;
  const newDisabled = disabledValue !== undefined ? disabledValue : target.disabled;

  db.prepare(
    'UPDATE users SET role = ?, display_name = ?, disabled = ?, updated_at = unixepoch() WHERE id = ?',
  ).run(newRole, newDisplayName, newDisabled, id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
  res.json(toUserOut(updated));
});

export default router;
