import type { AuthMeOut } from './api.js';

// Shared client-side ownership check for models/collections (Phase D4,
// #2180, plan §6). Mirrors api/src/routes/models.ts's/collections.ts's
// own `isOwnerOrAdmin` EXACTLY:
//
//   row.owner_id === req.user!.id || req.user!.role === 'admin'
//
// -- including its NULL-owner_id behavior. A JS `null === me.id` is
// always false (me.id is never null for a resolved caller), so a
// NULL-owned row (pre-Phase-D legacy models/collections created before
// ownership existed) is editable by admins only, same as server-side.
// This file exists so ModelPage/CollectionPage don't each reimplement
// that rule slightly differently -- gating here is a UX nicety, NOT the
// security boundary; the server enforces the real rule independently on
// every PATCH/DELETE/mutation route regardless of what this returns.
//
// `me: null` (fetch-in-flight, fetch-failed, or logged out) always
// resolves to false -- least-privilege by default, never a crash.
export function isOwnerOrAdmin(ownerId: string | null, me: AuthMeOut | null): boolean {
  if (!me) return false;
  if (me.role === 'admin') return true;
  return ownerId !== null && ownerId === me.id;
}
