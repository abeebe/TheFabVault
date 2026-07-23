// Coverage for apiFetch's error-unwrapping (#2181). Every route on the
// server responds to a 4xx/5xx with `{ error: string }` JSON (see
// routes/*.ts's `res.status(...).json({ error: ... })` convention).
// apiFetch used to throw the raw response body verbatim, so every caller
// either got '{"error":"..."}' as the message or had to parse it
// themselves -- this exercises the central fix directly, via a real
// api.* call (not a mocked one), by stubbing global.fetch.
//
// api.health() is used as the exercise surface: it's a plain GET with no
// side effects and no request body, so it's the smallest real call that
// still goes through the full apiFetch path.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { api } from '../lib/api.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('apiFetch error unwrapping (#2181)', () => {
  it('unwraps a {error: string} JSON body into the thrown Error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(409, { error: 'You cannot disable your own account' })));

    await expect(api.health()).rejects.toThrow('You cannot disable your own account');
  });

  it('falls back to the raw text for a non-JSON error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(502, 'Bad Gateway')));

    await expect(api.health()).rejects.toThrow('Bad Gateway');
  });

  it('falls back to raw text when the JSON body has no string `error` field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(400, { message: 'not the expected shape' })));

    await expect(api.health()).rejects.toThrow('{"message":"not the expected shape"}');
  });

  it('falls back to `HTTP <status>` when the body is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(textResponse(500, '')));

    await expect(api.health()).rejects.toThrow('HTTP 500');
  });

  it('still short-circuits a 401 into a plain "Unauthorized" (unaffected by the unwrap change)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'expired token' })));

    await expect(api.health()).rejects.toThrow('Unauthorized');
  });
});
