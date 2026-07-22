// Shared URL validators for TEXT columns that store user- or
// import-supplied URLs, sibling to enumValidators.ts (same "validate at
// the layer that can change without a migration" idiom, just for a
// shape richer than a fixed enum set).
//
// Why this exists (#2165, follow-up to Kit's A4 #2157 review finding):
// models.sourceUrl was `.trim()`-only at the API boundary — a stored
// XSS vector via `javascript:` URLs rendered as an anchor href on the
// client (web/src/lib/markdown.tsx's isSafeUrl guards the *render*
// side, but nothing guarded the *write* side). Phase C's zip import
// will populate sourceUrl straight from untrusted third-party
// metadata, so a client-only guard isn't enough — anything writing
// through the API directly (curl, the importer, a future integration)
// needs the same floor.
//
// Semantics deliberately mirror markdown.tsx's isSafeUrl (http/https
// only) MINUS mailto: a sourceUrl is attribution for an external model
// page, not an inline markdown link, so a mailto: address never makes
// sense there. If that reasoning is wrong, that's a product call, not
// an engineering one — flag it back rather than silently allowing it.
//
// Deliberately uses `new URL(value)` with NO base argument, unlike
// isSafeUrl's `new URL(url, 'https://placeholder.invalid')`. isSafeUrl
// needs a base because it's validating hrefs that are legitimately
// relative within rendered markdown; sourceUrl is supposed to be a
// fully-qualified external URL, so a bare relative string (no scheme)
// SHOULD fail here rather than silently resolve against a placeholder
// origin. `new URL()` alone still gets us the normalization we need
// for free (trims interior whitespace in the scheme, lowercases the
// protocol) so a regex/substring scheme check is neither necessary nor
// as safe — see the `javascript:`/`JaVaScRiPt:` test cases.

const ALLOWED_SOURCE_URL_PROTOCOLS = new Set(['http:', 'https:']);

// null/undefined/empty-after-trim are all treated as "no source URL"
// and pass — sourceUrl is optional. Anything else must be a
// `new URL()`-parseable absolute URL with an http/https protocol.
export function isValidSourceUrl(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return true;

  try {
    const parsed = new URL(trimmed);
    return ALLOWED_SOURCE_URL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}
