// Regression test for #2075: index.ts pins
// `app.set('trust proxy', '10.10.5.16')` (NPM's exact address) so
// X-Forwarded-For is only consulted for requests that genuinely arrived
// via NPM — see the load-bearing comment at that call site and at the
// login rate limiter in routes/auth.ts for the full mechanism. Neither
// had a test proving the EXACT-match semantics actually hold: that a
// request whose peer is NOT 10.10.5.16 can carry any X-Forwarded-For it
// likes and Express will still ignore it (falling back to the real
// socket peer for req.ip and therefore for the login rate limiter's
// key), while a request whose peer genuinely IS 10.10.5.16 has its
// X-Forwarded-For honored.
//
// This suite's bootApp is deliberately its own (not auth.test.ts's,
// which explicitly does NOT set trust proxy — seeauth.test.ts's own
// file-header rationale). The one seam this file adds beyond ordinary
// supertest/fetch-over-loopback: an http.Server 'connection' listener
// that shadows `socket.remoteAddress` with an own property before
// Express ever reads it, so a test can assert "as if this request's
// peer were <address>" without needing a second real host to connect
// from. `remoteAddress` on net.Socket is a plain prototype getter with
// no instance-level override by default, so
// `Object.defineProperty(socket, 'remoteAddress', { value, configurable: true })`
// legitimately shadows it for that one connection — this does not
// touch index.ts or any other production code path.

import {
  describe, expect, it, vi, afterEach,
} from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { LOGIN_MAX_ATTEMPTS } from '../routes/auth.js';
// Same constant index.ts's `app.set('trust proxy', ...)` configures —
// imported, not re-typed as a literal, so this suite can never silently
// drift from what production actually pins (see config.ts's comment).
import { TRUSTED_PROXY_ADDR } from '../config.js';

interface Booted {
  baseUrl: string;
  close: () => Promise<void>;
}

const booted: Booted[] = [];

/**
 * Boots a minimal Express app that mirrors index.ts's exact-address
 * trust-proxy pinning (the actual line under test) plus the real
 * authRouter, and a bare `/whoami` route that echoes `req.ip` — a
 * direct, business-logic-free probe of the trust-proxy resolution
 * itself, alongside the real login rate limiter for the
 * keying-uses-real-peer assertions.
 *
 * `simulatedPeer`, when set, shadows every connection's
 * `socket.remoteAddress` on this server for the lifetime of the boot —
 * good enough here because each test boots its own server/port and
 * never needs to mix peer identities within one boot (see file header).
 */
async function bootApp(opts: {
  seedAdmin?: { username: string; password: string };
  simulatedPeer?: string;
} = {}): Promise<Booted> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabvault-trustproxytest-'));
  process.env.DATA_DIR = dataDir;
  if (opts.seedAdmin) {
    process.env.AUTH_USERNAME = opts.seedAdmin.username;
    process.env.AUTH_PASSWORD = opts.seedAdmin.password;
  } else {
    delete process.env.AUTH_USERNAME;
    delete process.env.AUTH_PASSWORD;
  }

  vi.resetModules();

  const dbMod = await import('../db.js');
  const authRouterMod = await import('../routes/auth.js');

  const app = express();
  app.use(express.json());
  // The exact line this whole suite exists to regression-test — kept
  // byte-for-byte identical to index.ts's pinning.
  app.set('trust proxy', TRUSTED_PROXY_ADDR);
  app.use('/', authRouterMod.default);
  app.get('/whoami', (req, res) => res.json({ ip: req.ip }));

  dbMod.getDb();

  const server: Server = app.listen(0);
  if (opts.simulatedPeer) {
    const peer = opts.simulatedPeer;
    server.on('connection', (socket) => {
      Object.defineProperty(socket, 'remoteAddress', { value: peer, configurable: true });
    });
  }
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const result: Booted = {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dbMod.closeDb();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  booted.push(result);
  return result;
}

afterEach(async () => {
  while (booted.length) {
    const b = booted.pop();
    await b?.close();
  }
  delete process.env.AUTH_USERNAME;
  delete process.env.AUTH_PASSWORD;
  delete process.env.DATA_DIR;
});

describe('trust proxy exact-match semantics (#2075)', () => {
  it('a request whose peer is NOT the trusted proxy has its forged X-Forwarded-For ignored — req.ip is the real peer', async () => {
    const app = await bootApp(); // no simulatedPeer — real loopback peer, e.g. 127.0.0.1
    const res = await fetch(`${app.baseUrl}/whoami`, {
      headers: { 'X-Forwarded-For': '6.6.6.6' },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).not.toBe('6.6.6.6');
    // The real socket peer for a loopback fetch — IPv4-mapped or plain,
    // depending on the platform's dual-stack resolution; either is the
    // untouched real address, not the forged header.
    expect(['127.0.0.1', '::1', '::ffff:127.0.0.1']).toContain(body.ip);
  });

  it('a request whose peer genuinely IS the trusted proxy address has its X-Forwarded-For honored', async () => {
    const app = await bootApp({ simulatedPeer: TRUSTED_PROXY_ADDR });
    const res = await fetch(`${app.baseUrl}/whoami`, {
      headers: { 'X-Forwarded-For': '203.0.113.42' },
    });
    const body = (await res.json()) as { ip: string };
    expect(body.ip).toBe('203.0.113.42');
  });

  it('login rate-limit keying: an untrusted peer cannot evade the limiter by rotating a forged X-Forwarded-For', async () => {
    const app = await bootApp({ seedAdmin: { username: 'admin', password: 'correct-horse-battery-staple' } });

    // Every attempt claims a DIFFERENT forged client via X-Forwarded-For.
    // If the limiter were (incorrectly) keying on the forged header, each
    // attempt would land in its own fresh bucket and never trip. Keying
    // on the real (untrusted) peer means they all collapse onto the same
    // bucket regardless of the header.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${app.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.${i}` },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
      });
      expect(res.status).toBe(401);
    }

    const limited = await fetch(`${app.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '9.9.9.9' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    expect(limited.status).toBe(429);
  });

  it('login rate-limit keying: through the trusted proxy, two distinct forwarded clients get independent buckets', async () => {
    const app = await bootApp({
      seedAdmin: { username: 'admin', password: 'correct-horse-battery-staple' },
      simulatedPeer: TRUSTED_PROXY_ADDR,
    });

    // Client A exhausts its own bucket.
    for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${app.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.1' },
        body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
      });
      expect(res.status).toBe(401);
    }
    const aLimited = await fetch(`${app.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.1' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    expect(aLimited.status).toBe(429);

    // Client B, forwarded through the same trusted proxy but a distinct
    // real client address, is unaffected by A's exhausted bucket.
    const bStillOk = await fetch(`${app.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.2' },
      body: JSON.stringify({ username: 'admin', password: 'wrong-password' }),
    });
    expect(bStillOk.status).toBe(401);
  });
});
