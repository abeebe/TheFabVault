import type { NextFunction, Request, Response } from 'express';

// Global error-handling middleware — the backstop for #2044.
//
// Mounted last in index.ts, after every route and after the 404 handler.
// Express only routes a request here when something calls next(err) —
// which happens automatically for a synchronous throw in a route handler,
// and via asyncHandler.ts for a rejected promise in an async one. Routes
// that already catch their own errors and send a response (most routers
// in this codebase do) never reach here, so this is a backstop, not a
// second handler for the same error — no double-handling.
//
// Always logs, always returns JSON, never leaks err.message/stack to the
// client. Routes that want a specific message (e.g. "Import failed")
// already catch and send it themselves; anything that reaches this
// generic handler is by definition a case nobody wrote a specific message
// for, so a generic message is the honest default, not a lazy one.
export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  console.error(`[api] Unhandled error on ${req.method} ${req.originalUrl}:`, err);

  if (res.headersSent) {
    // A response is already in flight (e.g. mid-stream zip download) —
    // hand off to Express's built-in final handler, which closes/destroys
    // the connection. Calling res.json() here would throw
    // ERR_HTTP_HEADERS_SENT and give us a second, worse crash.
    next(err);
    return;
  }

  res.status(500).json({ error: 'Internal server error' });
}
