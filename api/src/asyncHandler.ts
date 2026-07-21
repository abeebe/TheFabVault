import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Express 4 catches a synchronous throw inside an ordinary route handler
// on its own (the call happens inside the router's own try/catch), but it
// does NOT await async handlers or attach a .catch() to their returned
// promise — a rejected promise from an `async (req, res) => {...}` route
// (or a synchronous throw inside one, which JS turns into a rejection the
// same way) becomes an unhandled promise rejection instead of an Express
// error. Before this ticket (#2044) that meant one bad await in a route
// took the whole process down; see the comment on
// routes/manifestImport.ts's upload-file handler, written before this
// wrapper existed, for the exact failure mode this closes.
//
// Wrap every `async` route handler with this so a rejection is forwarded
// to next(err) — which errorMiddleware.ts (mounted last in index.ts)
// turns into a clean 500 instead of a crash. New async routes should use
// this too; it's cheap insurance even on a route that already has its own
// try/catch (defense in depth — e.g. code that runs before the try block
// still gets caught).
export function asyncHandler<
  Req extends Request = Request,
  Res extends Response = Response,
>(
  fn: (req: Req, res: Res, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req as Req, res as Res, next)).catch(next);
  };
}
