// Tests for the #2060 fix: the Puppeteer-thumbnail-renderer-only
// `/internal/asset-raw/:id/:filename` route (index.ts) must reject any
// request whose real TCP peer isn't loopback, regardless of what the
// port is reachable from (docker-compose.production.yml publishes the
// api container's port directly on the host — see
// Reports/vera-fabvault-auth-migration-security-review-2026-07-08.md,
// "HIGH — Unauthenticated raw-file disclosure").
//
// Two layers, matching how the fix itself is layered:
//
// 1. `isLoopbackAddress` — a pure predicate — is exercised directly
//    against every address shape Node can hand back for
//    req.socket.remoteAddress, including the two forms the renderer's
//    own call path (services/thumbGen.ts fetches
//    `http://localhost:${serverPort}/internal/asset-raw/...`) can
//    actually produce depending on whether the OS/Node resolves
//    "localhost" to the IPv4 or IPv6 loopback address.
// 2. `requireLoopback` — the Express middleware — is exercised both as
//    a direct unit call (the only practical way to simulate a
//    *non*-loopback remoteAddress; you cannot get a real socket to
//    report a spoofed peer address without an actual second host) and,
//    for the loopback-allowed path, as a real end-to-end HTTP request
//    against a route wired up exactly like the real
//    `/internal/asset-raw/:id/:filename` registration in index.ts —
//    proving the guard doesn't accidentally block the renderer's own
//    real request path.

import {
  describe, expect, it, vi,
} from 'vitest';
import express, { Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import { isLoopbackAddress, requireLoopback } from '../internalAccess.js';

describe('isLoopbackAddress', () => {
  it('accepts plain IPv4 loopback', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
  });

  it('accepts the wider 127.0.0.0/8 IPv4 loopback range, not just 127.0.0.1', () => {
    expect(isLoopbackAddress('127.0.0.2')).toBe(true);
    expect(isLoopbackAddress('127.1.2.3')).toBe(true);
  });

  it('accepts IPv6 loopback', () => {
    expect(isLoopbackAddress('::1')).toBe(true);
  });

  it('accepts IPv4-mapped-IPv6 loopback — what Node reports for an IPv4 peer on a dual-stack ("::") listener', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects a real LAN address', () => {
    expect(isLoopbackAddress('10.10.5.50')).toBe(false);
  });

  it('rejects a public IP', () => {
    expect(isLoopbackAddress('8.8.8.8')).toBe(false);
  });

  it('rejects an IPv4-mapped-IPv6 non-loopback address', () => {
    expect(isLoopbackAddress('::ffff:10.10.5.50')).toBe(false);
  });

  it('rejects undefined, null, and empty string', () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('requireLoopback middleware (direct unit call)', () => {
  it('403s and does not call next() for a non-loopback remoteAddress — the load-bearing #2060 case', () => {
    const req = { socket: { remoteAddress: '10.10.5.50' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireLoopback(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when remoteAddress is missing entirely (fails closed, not open)', () => {
    const req = { socket: {} } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireLoopback(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() and does not touch the response for IPv4 loopback', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireLoopback(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() for IPv6 loopback', () => {
    const req = { socket: { remoteAddress: '::1' } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    requireLoopback(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('GET /internal/asset-raw/:id/:filename (real HTTP, guard wired exactly like index.ts)', () => {
  it('serves the file for a real loopback request', async () => {
    // A standalone file on disk, deliberately not going through
    // services/fileStore.ts (which needs config.storageDir / a live DB
    // and isn't what's under test here) — this test is about the guard
    // sitting in front of the handler, not about file storage.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-asset-raw-test-'));
    const filePath = path.join(dir, 'part.stl');
    const contents = 'not-a-real-stl-just-test-bytes';
    fs.writeFileSync(filePath, contents);

    const app = express();
    // Same shape as index.ts: guard first, handler second, on the real
    // route path.
    app.get('/internal/asset-raw/:id/:filename', requireLoopback, (_req, res) => {
      res.sendFile(filePath, (err) => {
        if (err && !res.headersSent) {
          res.status(404).json({ error: 'File not found' });
        }
      });
    });

    // No explicit host, matching index.ts's `app.listen(config.port, …)`
    // — this binds dual-stack, so a client connecting via the literal
    // IPv4 loopback address below genuinely exercises the
    // "::ffff:127.0.0.1" normalization branch of isLoopbackAddress
    // against real Node/OS behavior, not just a hand-picked string.
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/internal/asset-raw/test-id/part.stl`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(contents);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
