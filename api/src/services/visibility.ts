// Shared SQL-fragment builder for visibility-scoped reads on models and
// collections (Phase B, #2167; wiring into actual queries is Phase D3
// per the restructure plan — this module is pre-written and unit-tested
// NOW, deliberately unused by any route yet).
//
// Both `models` and `collections` (migrations v15/v16) carry the same
// two-value `visibility` TEXT column ('public'/'private', no CHECK —
// see enumValidators.ts) plus an `owner_id`. The rule is identical for
// both tables and is spelled out in the restructure plan's "Key design
// decisions" #4:
//
//   visible if: visibility = 'public'  OR  owner_id = <caller>  OR  <caller is admin>
//
// `isAdmin` is a plain caller-side boolean (already known from
// req.user.role at the time a route calls this — see auth.ts), not a
// value that ever needs to travel through to SQLite as a bound
// parameter. So an admin caller collapses the whole fragment to an
// always-true `1=1` with zero params, rather than growing the SQL
// string with an `OR ?` the caller would otherwise have to remember to
// bind `true`/`1` for. A logged-out caller (no userId) collapses the
// owner_id branch away entirely, rather than binding a NULL that could
// never equal any owner_id anyway (`owner_id = NULL` is never true in
// SQL regardless — dropping the clause is just clearer than relying on
// that).
//
// Callers splice `sql` into their own WHERE clause (`AND (${sql})`,
// matching the `whereClause`/`whereParams` accumulation pattern already
// used in routes/models.ts and routes/assets.ts) and spread `params` in
// at the matching position in their bound-parameter list.
//
// Once Phase D3 threads this in, every list/detail query on models and
// collections gains one more `AND (${visibilityFragment(ctx).sql})`
// clause with `...frag.params` appended — nothing about the shape below
// needs to change to support that, which is the whole point of writing
// it now instead of inline at that point.

export interface VisibilityContext {
  // The requesting user's id, or null for an unauthenticated context.
  // In practice every route that will consume this sits behind
  // requireAuth (see auth.ts), so userId is null only in tests/direct
  // calls exercising the "logged-out" branch on purpose.
  userId: string | null;
  // Whether the requesting user has the admin role (req.user.role ===
  // 'admin'). Admins bypass visibility entirely — same rule auth.ts's
  // requireAdmin already encodes for route-level gating; this is the
  // row-level equivalent.
  isAdmin: boolean;
}

export interface SqlFragment {
  // A boolean SQL expression, safe to splice directly into a WHERE
  // clause (`... AND (${sql})`). Never itself an untrusted string —
  // built entirely from the two fixed shapes below, never from
  // caller-provided data.
  sql: string;
  // Positional `?` bind values for `sql`, in order. Empty when `sql`
  // has no placeholders (the admin and logged-out branches).
  params: unknown[];
}

/**
 * Builds the visibility WHERE-fragment for a models/collections query.
 *
 * - Admin: `1=1` (no filtering — the whole point of being admin), no
 *   params.
 * - Authenticated non-admin: `(visibility = 'public' OR owner_id = ?)`,
 *   with the caller's own id as the one bound param — public rows are
 *   visible to everyone, private rows only to their owner.
 * - No caller (userId null, isAdmin false): `visibility = 'public'`, no
 *   params — the only thing anonymous/unresolved-caller context can
 *   ever see is public rows.
 */
export function visibilityFragment(ctx: VisibilityContext): SqlFragment {
  if (ctx.isAdmin) {
    return { sql: '1=1', params: [] };
  }
  if (ctx.userId) {
    return { sql: "(visibility = 'public' OR owner_id = ?)", params: [ctx.userId] };
  }
  return { sql: "visibility = 'public'", params: [] };
}
