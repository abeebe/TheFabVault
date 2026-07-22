// Express Request augmentation — adds `req.user`, populated by
// requireAuth/requireAdmin (auth.ts) after they've already looked up
// the live users row to validate the token's `sub`. That lookup was
// previously thrown away once the middleware decided allow/deny;
// downstream route handlers that also needed the user (e.g. "who
// owns this model") had to re-fetch it themselves via
// getUserByUsername(). This makes the row available on the request
// object instead, at zero extra DB cost (#2154, Phase A).
//
// Optional (`user?:`) because plenty of routes have no auth
// middleware in front of them at all (health check, etc.) — a route
// that reads req.user must itself sit behind requireAuth/requireAdmin
// for that read to be meaningful; the type doesn't (and can't) enforce
// that ordering, same as any other Express middleware-attached field.
import type { UserRow } from './index.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRow;
    }
  }
}

export {};
