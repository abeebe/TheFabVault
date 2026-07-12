// Tests for the version-archives storage bucketing (services/storageStats.ts)
// — Sloane's PRD feasibility Q5: fold the new "how many bytes are version
// archives" figure into the SAME recursive walk getStorageBreakdown()
// already does over STORAGE_DIR, rather than a second full pass.
//
// walkDirectorySize() is pure filesystem math with no DB dependency, so
// these tests build a synthetic directory tree with fs.mkdtempSync and
// call it directly — no need for the vi.resetModules()/env-var dance
// getStorageBreakdown() itself would require (that's exercised at the
// mountImport integration-test layer instead).

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { walkDirectorySize, calculateDirectorySize } from '../services/storageStats.js';

const dirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfv-storagestats-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe('walkDirectorySize', () => {
  it('returns 0/0 for a directory that does not exist', () => {
    const result = walkDirectorySize('/definitely/does/not/exist/xyz');
    expect(result).toEqual({ total: 0, versions: 0 });
  });

  it('sums plain files with no versions/ subdirectory as versions: 0', () => {
    const root = makeTmpDir();
    fs.writeFileSync(path.join(root, 'a.stl'), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, 'b.stl'), Buffer.alloc(250));

    const result = walkDirectorySize(root);
    expect(result.total).toBe(350);
    expect(result.versions).toBe(0);
  });

  it('buckets bytes under a versions/ directory separately from the total', () => {
    // Mirrors the real on-disk shape: <STORAGE_DIR>/<assetId>/file.stl
    // plus <STORAGE_DIR>/<assetId>/versions/<versionId>_file.stl
    const root = makeTmpDir();
    const assetDir = path.join(root, 'asset-123');
    const versionsDir = path.join(assetDir, 'versions');
    fs.mkdirSync(versionsDir, { recursive: true });

    fs.writeFileSync(path.join(assetDir, 'part.stl'), Buffer.alloc(1000)); // live file
    fs.writeFileSync(path.join(versionsDir, 'v1_part.stl'), Buffer.alloc(400)); // archived
    fs.writeFileSync(path.join(versionsDir, 'v2_part.stl'), Buffer.alloc(300)); // archived

    const result = walkDirectorySize(root);
    expect(result.total).toBe(1700); // 1000 + 400 + 300
    expect(result.versions).toBe(700); // 400 + 300, not the live file
  });

  it('buckets nested files inside versions/ at any depth (not just direct children)', () => {
    const root = makeTmpDir();
    const nested = path.join(root, 'asset-1', 'versions', 'weirdly', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'deep.stl'), Buffer.alloc(50));
    fs.writeFileSync(path.join(root, 'asset-1', 'live.stl'), Buffer.alloc(20));

    const result = walkDirectorySize(root);
    expect(result.total).toBe(70);
    expect(result.versions).toBe(50);
  });

  it('does not bucket a directory merely named something-versions or Versions (exact segment match only)', () => {
    const root = makeTmpDir();
    fs.mkdirSync(path.join(root, 'old-versions-backup'), { recursive: true });
    fs.writeFileSync(path.join(root, 'old-versions-backup', 'x.stl'), Buffer.alloc(10));

    const result = walkDirectorySize(root);
    expect(result.total).toBe(10);
    expect(result.versions).toBe(0); // 'old-versions-backup' !== 'versions'
  });

  it('sums across multiple asset directories, each with its own versions/ subdir', () => {
    const root = makeTmpDir();
    for (const [assetId, liveSize, versionSize] of [
      ['asset-a', 500, 100],
      ['asset-b', 800, 0], // never versioned — no versions/ dir at all
      ['asset-c', 200, 900],
    ] as const) {
      const dir = path.join(root, assetId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'f.stl'), Buffer.alloc(liveSize));
      if (versionSize > 0) {
        fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'versions', 'v1_f.stl'), Buffer.alloc(versionSize));
      }
    }

    const result = walkDirectorySize(root);
    expect(result.total).toBe(500 + 100 + 800 + 200 + 900);
    expect(result.versions).toBe(100 + 900);
  });
});

describe('calculateDirectorySize (back-compat wrapper)', () => {
  it('still returns just the total, matching pre-Q5 behavior', () => {
    const root = makeTmpDir();
    const versionsDir = path.join(root, 'asset-1', 'versions');
    fs.mkdirSync(versionsDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'asset-1', 'f.stl'), Buffer.alloc(30));
    fs.writeFileSync(path.join(versionsDir, 'v1_f.stl'), Buffer.alloc(70));

    expect(calculateDirectorySize(root)).toBe(100);
  });
});
