// Focused tests for the upload pipeline. The store recently moved to
// module scope with a streaming hash + worker pools; these tests cover
// the surface that's easiest to silently break:
//   - state transitions visible to subscribers
//   - the streaming sha256Hex helper (Web Crypto can't do this so the
//     impl uses js-sha256 over file.stream() chunks)
//   - duplicate auto-skip path above the threshold
//
// They don't cover the real HTTP upload — that needs the actual server.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the api module before importing the store so the worker pool
// never hits the network.
vi.mock('../lib/api.js', () => {
  const uploadMock = vi.fn(async (file: File) => ({
    id: `id-${file.name}`,
    filename: file.name,
    originalName: file.name,
    mime: 'application/octet-stream',
    size: file.size,
    folderId: null,
    tags: [],
    notes: null,
    thumbStatus: 'none',
    thumbUrl: null,
    url: `/file/id-${file.name}`,
    meta: {},
    createdAt: Date.now(),
    category: null,
    deletedAt: null,
    rating: null,
    isFavorite: false,
  }));
  return {
    api: {
      assets: {
        upload: uploadMock,
        checkHash: vi.fn(async () => ({ exists: false })),
      },
      projects: {
        addAssets: vi.fn(async () => undefined),
      },
    },
  };
});

import {
  getSnapshot, subscribe, startUploads, clearItems, setPanelOpen,
} from '../lib/uploadStore.js';
import { api } from '../lib/api.js';

function makeFile(name: string, size = 16): File {
  const blob = new Blob([new Uint8Array(size)], { type: 'application/octet-stream' });
  return new File([blob], name, { type: 'application/octet-stream' });
}

beforeEach(() => {
  clearItems();
  setPanelOpen(false);
  vi.mocked(api.assets.upload).mockClear();
  // Reset to a clean "no duplicates" implementation so per-test
  // mockImplementation overrides don't leak across tests.
  vi.mocked(api.assets.checkHash).mockReset();
  vi.mocked(api.assets.checkHash).mockResolvedValue({ exists: false });
});

describe('uploadStore', () => {
  it('opens the panel and adds pending items when an upload starts', async () => {
    const files = [makeFile('a.bin'), makeFile('b.bin')];
    const done = startUploads(files, { folderId: null });

    // Snapshot right after kickoff — items should already be in the list.
    const s = getSnapshot();
    expect(s.panelOpen).toBe(true);
    expect(s.items.length).toBe(2);
    expect(s.batchTotal).toBe(2);
    expect(s.items.every((i) => i.bytesTotal === 16)).toBe(true);

    await done;
  });

  it('drives every file to status=done when uploads succeed', async () => {
    const files = [makeFile('one.bin'), makeFile('two.bin')];
    await startUploads(files, { folderId: null });

    const finalItems = getSnapshot().items;
    expect(finalItems.every((i) => i.status === 'done')).toBe(true);
    expect(getSnapshot().phase).toBe('done');
    expect(api.assets.upload).toHaveBeenCalledTimes(2);
  });

  it('auto-skips duplicates in the pipelined path (batches > 20 files)', async () => {
    // First two files report as existing duplicates; rest are fresh.
    vi.mocked(api.assets.checkHash).mockImplementation(async (hash: string) => {
      // Distinguish by which call this is — first two trigger dup.
      const count = vi.mocked(api.assets.checkHash).mock.calls.length;
      if (count <= 2) {
        return {
          exists: true,
          asset: {
            id: 'existing', filename: 'old', originalName: 'old',
            mime: '', size: 0, folderId: null, tags: [], notes: null,
            thumbStatus: 'none', thumbUrl: null, url: '', meta: {},
            createdAt: 0, category: null, deletedAt: null, rating: null,
            isFavorite: false,
          },
        };
      }
      return { exists: false };
    });

    const files = Array.from({ length: 25 }, (_, i) => makeFile(`f${i}.bin`));
    await startUploads(files, { folderId: null });

    const items = getSnapshot().items;
    const skipped = items.filter((i) => i.error === 'Skipped — already in vault');
    const uploaded = items.filter((i) => i.status === 'done');

    expect(skipped.length).toBe(2);
    expect(uploaded.length).toBe(23);
    expect(api.assets.upload).toHaveBeenCalledTimes(23);
  });

  it('notifies subscribers on state changes', async () => {
    const seen: number[] = [];
    const unsub = subscribe(() => { seen.push(getSnapshot().items.length); });

    await startUploads([makeFile('x.bin')], { folderId: null });

    unsub();
    // At minimum: initial item add (1), status changes (>=2).
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0]).toBe(1);
  });
});
