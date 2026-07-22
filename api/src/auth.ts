import jwt from 'jsonwebtoken';
import { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import { getJwtSecret, getUserByUsername } from './db.js';

export interface JwtPayload {
  sub: string;
  iat?: number;
  exp?: number;
}

// Single allowlisted algorithm. The secret is always a plain string (not a
// PEM/public key object) so jsonwebtoken already restricts acceptance to
// HMAC algorithms — passing this explicitly is zero-cost defense-in-depth
// against the classic RS256/HS256 key-confusion attack.
const JWT_ALGORITHMS: jwt.Algorithm[] = ['HS256'];

// Deliberately still just `{ sub: username }` — no role/id/disabled claim
// was added for Phase D (#2177), on purpose. role and disabled are always
// read from the live `users` row on every request (requireAuth/
// requireAdmin below), never trusted off the token itself. That is
// exactly why disabling a user or demoting an admin takes effect on their
// very next request instead of waiting for the JWT to expire (config.jwtTtl
// can be hours) — baking role/disabled into the claims would reintroduce
// that staleness window. Do not add either claim without re-deriving this
// property some other way first.
export function createToken(username: string): string {
  return jwt.sign({ sub: username }, getJwtSecret(), {
    expiresIn: config.jwtTtl,
    algorithm: 'HS256',
  });
}

function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const queryToken = req.query.token as string | undefined;
  return headerToken ?? queryToken ?? null;
}

/**
 * Verify the request carries a token signed with the current JWT secret
 * AND that the token's `sub` still matches a live row in `users`.
 *
 * There is deliberately no "is auth enabled" bypass branch here anymore.
 * The old shape — `if (!config.authEnabled) { next(); return; }` — was
 * the actual vulnerability: whenever authEnabled resolved false (empty
 * env vars, or any future misconfiguration), every route below this
 * middleware was reachable with zero verification. Removing the branch
 * entirely, rather than just making its resolution "safer," means there
 * is no code path left that can silently skip the check — every request
 * either passes a positive, DB-confirmed check or gets denied. This also
 * covers Vera's two required fail-closed cases without a special case
 * for either: an empty `users` table means getUserByUsername() can never
 * match (deny), and a DB read error makes getUserByUsername() fail
 * closed and return null (deny) — same outcome, same code path.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, getJwtSecret(), { algorithms: JWT_ALGORITHMS }) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // getUserByUsername fails closed (returns null on any DB error), so a
  // transient SQLite hiccup denies the request rather than granting it.
  const user = getUserByUsername(decoded.sub);
  if (!user || user.disabled) {
    // Same response for "no such user" and "disabled user" — don't leak
    // which one it is. This re-fetch happens on every request (there is
    // no session/claims cache), so an admin flipping `disabled` to 1
    // (routes/users.ts PATCH) revokes every existing JWT for that user
    // immediately — the token itself never encodes role/disabled state
    // (see createToken's comment), so there is nothing to revoke except
    // by re-checking the live row, which this already does.
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Attach the row we already fetched (see types/express.d.ts) so
  // downstream handlers don't need a second getUserByUsername() lookup
  // for the common "who is making this request" question.
  req.user = user;
  next();
}

/**
 * Same token-validity + live-user check as requireAuth (including the
 * disabled-user re-fetch below), plus role === 'admin'. As of migration
 * v15 / Phase D (#2177) the schema genuinely allows a non-admin 'member'
 * role, so this check is no longer a formality — it is what keeps a
 * member out of every admin-only route (mounts config, routes/users.ts,
 * etc.).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, getJwtSecret(), { algorithms: JWT_ALGORITHMS }) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Same fail-closed disabled check as requireAuth — see that function's
  // comment for why this re-fetch is what makes disabling a user (or, via
  // the role check just below, demoting an admin) take effect on the very
  // next request rather than waiting out the token's TTL.
  const user = getUserByUsername(decoded.sub);
  if (!user || user.disabled) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Forbidden: admin access required' });
    return;
  }

  req.user = user;
  next();
}
