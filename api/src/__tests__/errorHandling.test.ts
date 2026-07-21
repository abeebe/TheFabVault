// Tests for #2044: global error-handling middleware, the async-route
// wrapper that feeds it, and the process-level unhandledRejection /
// uncaughtException guards.
//
// Before this ticket: an async route handler (`async (req, res) => {...}`)
// that rejected — including a plain `throw` inside one — became an
// unhandled promise rejection with nothing attached to Express's error
// pipeline. Node logs an unhandledRejection warning and, depending on
// version/flags, can terminate the process; either way nothing sent a
// response and nothing kept the API serving other requests reliably.
//
// The core claim under test in the last describe block: a real HTTP
// request to a throwing async route now gets a clean 500 (not a hang,
// not a crash), and the SAME server instance still answers a second,
// unrelated request afterward — i.e. one bad route no longer takes the
// whole process down with it.

import {
  describe, expect, it, vi, beforeEach, afterEach,
} from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'net';
import { asyncHandler } from '../asyncHandler.js';
import { errorMiddleware } from '../errorMiddleware.js';
import { logUnhandledRejection, logUncaughtExceptionAndExit } from '../processGuards.js';

describe('asyncHandler', () => {
  it('forwards a rejected promise to next() instead of leaving it unhandled', async () => {
    const err = new Error('boom');
    const handler = asyncHandler(async () => {
      throw err;
    });
    const next = vi.fn();
    await handler({} as Request, {} as Response, next as NextFunction);
    // Promise.resolve(...).catch(next) schedules a microtask; give it a
    // tick before asserting.
    await Promise.resolve();
    expect(next).toHaveBeenCalledWith(err);
  });

  it('forwards a synchronous throw inside an async fn to next() the same way', async () => {
    // `async () => { throw x }` and `async () => { return Promise.reject(x) }`
    // are indistinguishable to the caller — both produce a rejected
    // promise. This test exists to make that equivalence explicit for
    // this codebase, not because the implementation branches on it.
    const err = new Error('sync-throw-in-async-fn');
    const handler = asyncHandler(async (_req, _res) => {
      if (true) throw err; // eslint-disable-line no-constant-condition
    });
    const next = vi.fn();
    await handler({} as Request, {} as Response, next as NextFunction);
    await Promise.resolve();
    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not call next() when the handler resolves normally', async () => {
    const handler = asyncHandler(async (_req, res: Response) => {
      (res as any).json({ ok: true });
    });
    const next = vi.fn();
    const res = { json: vi.fn() } as unknown as Response;
    await handler({} as Request, res, next as NextFunction);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });
});

function mockRes() {
  const res: any = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}

describe('errorMiddleware', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('logs and returns a generic 500 JSON body when headers are not sent', () => {
    const req = { method: 'GET', originalUrl: '/asset/123' } as Request;
    const res = mockRes();
    const next = vi.fn();

    errorMiddleware(new Error('db exploded'), req, res, next);

    expect(errSpy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not leak the raw error message or stack to the client', () => {
    const req = { method: 'POST', originalUrl: '/upload' } as Request;
    const res = mockRes();
    const secretish = new Error('password=hunter2 connection string leaked here');

    errorMiddleware(secretish, req, res, vi.fn());

    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('hands off to next(err) instead of writing a second response when headers are already sent', () => {
    const req = { method: 'GET', originalUrl: '/folder/1/download' } as Request;
    const res = mockRes();
    res.headersSent = true;
    const next = vi.fn();
    const err = new Error('mid-stream failure');

    errorMiddleware(err, req, res, next);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('processGuards', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('logUnhandledRejection logs but never exits the process', () => {
    expect(() => logUnhandledRejection('some rejection reason')).not.toThrow();
    expect(errSpy).toHaveBeenCalledWith(
      '[api] Unhandled promise rejection:',
      'some rejection reason',
    );
  });

  it('logUncaughtExceptionAndExit logs and calls the injected exit function with code 1 (never a bare process.exit call in the test)', () => {
    const exit = vi.fn();
    const err = new Error('unrecoverable');
    logUncaughtExceptionAndExit(err, exit);
    expect(errSpy).toHaveBeenCalledWith('[api] Uncaught exception, exiting:', err);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('end-to-end: a throwing async route 500s instead of crashing the process', () => {
  it('returns 500 for the throwing route, then still serves a second, unrelated request on the same server', async () => {
    const app = express();

    app.get('/ok', (_req, res) => res.json({ ok: true }));

    // Mirrors the real registration shape: async handler wrapped in
    // asyncHandler, exactly like routes/assets.ts's /upload after #2044.
    app.get('/throws', asyncHandler(async () => {
      throw new Error('simulated route failure');
    }));

    app.use((_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });

    // Same position as index.ts: mounted last.
    app.use(errorMiddleware);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      // The route that used to take the whole process down.
      const failing = await fetch(`http://127.0.0.1:${port}/throws`);
      expect(failing.status).toBe(500);
      expect(await failing.json()).toEqual({ error: 'Internal server error' });
      expect(errSpy).toHaveBeenCalled();

      // The proof that matters: the server is still up and correctly
      // serving a completely unrelated request afterward. Before this
      // fix, the failure mode was the whole Node process going down —
      // this second request would simply never get an answer.
      const healthy = await fetch(`http://127.0.0.1:${port}/ok`);
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toEqual({ ok: true });
    } finally {
      errSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
