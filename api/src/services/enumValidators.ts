// Shared enum validators for TEXT columns that intentionally carry NO
// SQL CHECK constraint.
//
// Why: SQLite has no `ALTER TABLE ... DROP/ALTER CONSTRAINT` — a CHECK
// baked into a CREATE TABLE can only ever be changed via the full
// table-copy dance (see migration v15's `users_new` in db.ts). Migration
// v13 did exactly that to `users.role` (`CHECK(role IN ('admin'))`) and
// migration v15 (#2154) had to burn a whole migration just to undo it
// for the multi-user pass. Every enum-shaped column introduced from v15
// onward is deliberately left as a bare `TEXT` in the schema and
// validated here instead, at the layer that can actually be changed
// without a migration: adding 'suspended' to UserRole next quarter is a
// one-line diff in this file, not a table-copy.
//
// Each validator is a TypeScript type guard (`value is T`) so callers in
// routes get narrowing for free: `if (!isUserRole(body.role)) return
// res.status(400)...` leaves `body.role` typed as `UserRole` after the
// guard, no separate cast needed.

function makeValidator<T extends string>(allowed: readonly T[]) {
  const set = new Set<string>(allowed);
  return (value: unknown): value is T => typeof value === 'string' && set.has(value);
}

// users.role (migration v15). requireAdmin (auth.ts) checks
// `=== 'admin'` directly and doesn't need to import this — it's here
// for routes/users.ts (Phase D) validating incoming role assignments.
export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const isUserRole = makeValidator(USER_ROLES);

// model_files.role (migration v15) — what a linked asset IS to the
// model it's attached to. 'part' = printable file, 'image' = gallery
// asset (rides the existing thumbnail pipeline), 'doc' = readme/
// instructions, 'other' = anything that doesn't fit the first three.
export const MODEL_FILE_ROLES = ['part', 'image', 'doc', 'other'] as const;
export type ModelFileRole = (typeof MODEL_FILE_ROLES)[number];
export const isModelFileRole = makeValidator(MODEL_FILE_ROLES);

// models.visibility (migration v15 column, enforcement lands in Phase B
// per the restructure plan's services/visibility.ts). Defined here now,
// alongside the column, rather than deferred to Phase B, so the type
// exists the moment the column does. 'public' = every logged-in user,
// 'private' = owner + admin only — advisory only against raw
// /file/:id /thumb/:id (see plan §Key design decisions #4).
export const MODEL_VISIBILITY = ['public', 'private'] as const;
export type ModelVisibility = (typeof MODEL_VISIBILITY)[number];
export const isModelVisibility = makeValidator(MODEL_VISIBILITY);
