// Dep-surface smoke tests.
//
// Goal: when a future package upgrade changes the shape of an API we rely
// on (e.g. uuid 10 → 14 ESM-only rewrite, mime-types 2 → 3 class refactor,
// archiver 7 → 8), `npm test` fails here BEFORE the change ships and
// breaks prod. Keep these focused on the call sites we actually use in
// src/ — not exhaustive API coverage of each library.

import { describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import mime from 'mime-types';
import archiver from 'archiver';
import { glob } from 'glob';
import PQueue from 'p-queue';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';

describe('uuid', () => {
  it('v4 returns a valid uuid string', () => {
    const id = uuidv4();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates distinct ids across calls', () => {
    const a = uuidv4();
    const b = uuidv4();
    expect(a).not.toBe(b);
  });
});

describe('mime-types', () => {
  it('looks up MIME for known asset extensions', () => {
    // These are the call shapes used in routes/assets.ts and
    // services/mountImport.ts. If mime-types 3.x ever drops one of
    // these, the upload pipeline silently returns octet-stream.
    expect(mime.lookup('thing.stl')).toBe('model/stl');
    expect(mime.lookup('thing.obj')).toBe('model/obj');
    expect(mime.lookup('image.png')).toBe('image/png');
    expect(mime.lookup('image.jpg')).toBe('image/jpeg');
    expect(mime.lookup('readme.txt')).toBe('text/plain');
  });

  it('returns false for unknown extensions (used to fall back to octet-stream)', () => {
    expect(mime.lookup('thing.unknown-xyzzy')).toBe(false);
  });
});

describe('archiver', () => {
  it('creates a zip stream with appended content', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c) => chunks.push(c));
    const done = new Promise<void>((resolve, reject) => {
      sink.on('end', () => resolve());
      sink.on('error', reject);
    });

    const zip = archiver('zip');
    zip.pipe(sink);
    zip.append('hello', { name: 'greet.txt' });
    await zip.finalize();
    await done;

    const buf = Buffer.concat(chunks);
    // Zip local file header magic — confirms we produced a real zip.
    expect(buf.slice(0, 4).toString('hex')).toBe('504b0304');
  });
});

describe('glob', () => {
  it('finds files matching a pattern in a temp dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfv-glob-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.stl'), 'x');
      fs.writeFileSync(path.join(dir, 'b.stl'), 'x');
      fs.writeFileSync(path.join(dir, 'c.png'), 'x');
      const matches = await glob('*.stl', { cwd: dir });
      expect(matches.sort()).toEqual(['a.stl', 'b.stl']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('p-queue', () => {
  it('enforces the configured concurrency limit', async () => {
    const queue = new PQueue({ concurrency: 2 });
    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = Array.from({ length: 10 }, () =>
      queue.add(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
      })
    );
    await Promise.all(tasks);

    expect(maxInFlight).toBe(2);
  });
});

describe('jsonwebtoken', () => {
  it('round-trips a payload through sign/verify', () => {
    const secret = 'test-secret';
    const token = jwt.sign({ sub: 'alice', role: 'admin' }, secret, { expiresIn: '1m' });
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
    expect(decoded.sub).toBe('alice');
    expect(decoded.role).toBe('admin');
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = jwt.sign({ sub: 'alice' }, 'right-secret');
    expect(() => jwt.verify(token, 'wrong-secret')).toThrow();
  });
});

describe('better-sqlite3', () => {
  it('opens an in-memory database and round-trips a row', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
    db.prepare('INSERT INTO t (id, n) VALUES (?, ?)').run('x', 42);
    const row = db.prepare('SELECT * FROM t WHERE id = ?').get('x') as { id: string; n: number };
    expect(row).toEqual({ id: 'x', n: 42 });
    db.close();
  });
});

describe('sharp', () => {
  it('reads metadata from a generated PNG', async () => {
    const png = await sharp({
      create: { width: 4, height: 3, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer();
    const meta = await sharp(png).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(4);
    expect(meta.height).toBe(3);
  });
});

describe('lightburn thumbnail extractor', () => {
  it('decodes the embedded PNG from a synthetic .lbrn file', async () => {
    const { extractLightburnThumbnail } = await import('../services/lightburnThumb.js');

    // Generate a tiny PNG via sharp, then wrap it in a minimal LightBurn
    // XML envelope to match the shape extractLightburnThumbnail expects.
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 12, g: 34, b: 56 } },
    }).png().toBuffer();
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<LightBurnProject AppVersion="1.0">\n' +
      `  <Thumbnail Source="${png.toString('base64')}"/>\n` +
      '</LightBurnProject>\n';

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfv-lbrn-'));
    const file = path.join(dir, 'test.lbrn');
    try {
      fs.writeFileSync(file, xml);
      const out = extractLightburnThumbnail(file);
      expect(out).not.toBeNull();
      // PNG magic number
      expect(out!.slice(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      const meta = await sharp(out!).metadata();
      expect(meta.width).toBe(2);
      expect(meta.height).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no <Thumbnail> element is present', () => {
    // Import statically — already loaded above via dynamic import, just
    // reuse to avoid a second async setup.
    return import('../services/lightburnThumb.js').then(({ extractLightburnThumbnail }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfv-lbrn-'));
      const file = path.join(dir, 'no-thumb.lbrn');
      try {
        fs.writeFileSync(file, '<?xml version="1.0"?><LightBurnProject></LightBurnProject>');
        expect(extractLightburnThumbnail(file)).toBeNull();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe('pdf thumbnail pipeline', () => {
  it('renders a generated PDF to a JPEG buffer end-to-end', async () => {
    // Generate a tiny one-page PDF in memory using @napi-rs/canvas's
    // built-in PDF surface, then feed it through pdfThumb. Covers both
    // deps (pdfjs-dist + @napi-rs/canvas) plus the renderer.
    const { renderPdfThumbnail } = await import('../services/pdfThumb.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfv-pdf-'));
    const pdfPath = path.join(dir, 'tiny.pdf');
    try {
      // Minimal hand-crafted single-page PDF (612x792, blank). Avoids
      // depending on yet another lib just to produce a test fixture.
      const pdf =
        '%PDF-1.4\n' +
        '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
        '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
        '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>>>endobj\n' +
        'xref\n0 4\n' +
        '0000000000 65535 f \n' +
        '0000000009 00000 n \n' +
        '0000000052 00000 n \n' +
        '0000000099 00000 n \n' +
        'trailer<</Size 4/Root 1 0 R>>\nstartxref\n160\n%%EOF';
      fs.writeFileSync(pdfPath, pdf);

      const jpeg = await renderPdfThumbnail(pdfPath);
      expect(jpeg.length).toBeGreaterThan(100);
      // JPEG SOI marker
      expect(jpeg.slice(0, 2).toString('hex')).toBe('ffd8');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
