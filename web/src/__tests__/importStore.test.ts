// Tests for the folder-import commit-phase store (lib/importStore.ts).
// Focus: the same-batch dedup resolution (a 'batch-link' item awaiting its
// 'new-upload' representative's real assetId) is the core new behavior
// this bet adds beyond what uploadStore.ts already does, and it's also
// the part most likely to deadlock or hang silently if the dependency
// wiring is wrong — so that gets the deepest coverage here.

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../lib/api.js', () => ({
  api: {
    manifest: {
      importUploadFile: vi.fn(),
      importLinkExisting: vi.fn(),
    },
  },
}));

import {
  getSnapshot, subscribe, startImport, cancelImport, resetImport,
  type ImportPlan, type ImportResolution,
} from '../lib/importStore.js';
import { api } from '../lib/api.js';

function makeFile(name: string): File {
  return new File([new Uint8Array(8)], name, { type: 'application/octet-stream' });
}

function makeAsset(id: string) {
  return {
    id, filename: id, originalName: id, mime: 'application/octet-stream', size: 8,
    folderId: null, tags: [], notes: null, thumbStatus: 'none' as const, thumbUrl: null,
    url: `/file/${id}`, meta: {}, createdAt: 0, category: null, deletedAt: null,
    rating: null, isFavorite: false,
  };
}

beforeEach(() => {
  resetImport();
  vi.mocked(api.manifest.importUploadFile).mockReset();
  vi.mocked(api.manifest.importLinkExisting).mockReset();
});

describe('importStore — basic commit flow', () => {
  it('resolves a mix of new-upload and vault-link items and finishes phase=done', async () => {
    vi.mocked(api.manifest.importUploadFile).mockResolvedValue({
      asset: makeAsset('new-1'), linked: false, subAssemblyId: 'sa-1', createdSubAssemblyIds: ['sa-1'],
    });
    vi.mocked(api.manifest.importLinkExisting).mockResolvedValue({
      asset: makeAsset('existing-1'), linked: true, subAssemblyId: 'sa-2', createdSubAssemblyIds: [],
    });

    const resolutions: ImportResolution[] = [
      { kind: 'new-upload', file: makeFile('a.stl'), segments: ['Right Foot'] },
      { kind: 'vault-link', file: makeFile('b.stl'), segments: ['Left Foot'], assetId: 'existing-1' },
    ];
    const plan: ImportPlan = {
      projectId: 'proj-1', parentSubAssemblyId: null, folderName: 'R2D2',
      resolutions, newSubAssemblyTotal: 2, mergedSubAssemblyTotal: 0,
    };

    await startImport(plan);

    const s = getSnapshot();
    expect(s.phase).toBe('done');
    expect(s.items.every((i) => i.status === 'done')).toBe(true);
    expect(s.items[0].linked).toBe(false);
    expect(s.items[1].linked).toBe(true);
    expect(s.newSubAssemblyIdsSeen.has('sa-1')).toBe(true);
    expect(api.manifest.importUploadFile).toHaveBeenCalledTimes(1);
    expect(api.manifest.importLinkExisting).toHaveBeenCalledTimes(1);
  });

  it('opens the panel and sets phase=committing as soon as the job starts', async () => {
    vi.mocked(api.manifest.importUploadFile).mockResolvedValue({
      asset: makeAsset('x'), linked: false, subAssemblyId: null, createdSubAssemblyIds: [],
    });
    const plan: ImportPlan = {
      projectId: 'proj-1', parentSubAssemblyId: null, folderName: 'Flat',
      resolutions: [{ kind: 'new-upload', file: makeFile('x.stl'), segments: [] }],
      newSubAssemblyTotal: 0, mergedSubAssemblyTotal: 0,
    };
    const done = startImport(plan);
    expect(getSnapshot().phase).toBe('committing');
    expect(getSnapshot().panelOpen).toBe(true);
    await done;
  });
});

describe('importStore — same-batch dedup (batch-link awaiting its representative)', () => {
  it('a batch-link file links to the assetId its representative upload actually resolved to', async () => {
    vi.mocked(api.manifest.importUploadFile).mockResolvedValue({
      asset: makeAsset('freshly-uploaded-id'), linked: false, subAssemblyId: 'sa-right', createdSubAssemblyIds: ['sa-right'],
    });
    vi.mocked(api.manifest.importLinkExisting).mockResolvedValue({
      asset: makeAsset('freshly-uploaded-id'), linked: true, subAssemblyId: 'sa-left', createdSubAssemblyIds: ['sa-left'],
    });

    // Right Foot/greeble.stl is the representative (index 0); Left
    // Foot/greeble.stl is a same-batch duplicate of it (index 1).
    const resolutions: ImportResolution[] = [
      { kind: 'new-upload', file: makeFile('greeble.stl'), segments: ['Right Foot'] },
      { kind: 'batch-link', file: makeFile('greeble.stl'), segments: ['Left Foot'], representativeIndex: 0 },
    ];
    const plan: ImportPlan = {
      projectId: 'proj-1', parentSubAssemblyId: null, folderName: 'R2D2',
      resolutions, newSubAssemblyTotal: 2, mergedSubAssemblyTotal: 0,
    };

    await startImport(plan);

    const s = getSnapshot();
    expect(s.items.every((i) => i.status === 'done')).toBe(true);
    expect(api.manifest.importUploadFile).toHaveBeenCalledTimes(1); // bytes sent exactly once
    expect(api.manifest.importLinkExisting).toHaveBeenCalledTimes(1);
    // The link call must reference the asset id the upload actually
    // returned, not some other id.
    expect(vi.mocked(api.manifest.importLinkExisting).mock.calls[0][1].assetId).toBe('freshly-uploaded-id');
  });

  it('when the representative upload fails, its batch-link dependents fail too instead of hanging forever', async () => {
    vi.mocked(api.manifest.importUploadFile).mockRejectedValue(new Error('network blip'));

    const resolutions: ImportResolution[] = [
      { kind: 'new-upload', file: makeFile('greeble.stl'), segments: ['Right Foot'] },
      { kind: 'batch-link', file: makeFile('greeble.stl'), segments: ['Left Foot'], representativeIndex: 0 },
      { kind: 'batch-link', file: makeFile('greeble.stl'), segments: ['Dome'], representativeIndex: 0 },
    ];
    const plan: ImportPlan = {
      projectId: 'proj-1', parentSubAssemblyId: null, folderName: 'R2D2',
      resolutions, newSubAssemblyTotal: 3, mergedSubAssemblyTotal: 0,
    };

    // Bounded by a real timeout via the test runner's default — if this
    // hangs, vitest's own test timeout catches it, but we also assert the
    // terminal state explicitly.
    await startImport(plan);

    const s = getSnapshot();
    expect(s.phase).toBe('done');
    expect(s.items.every((i) => i.status === 'error')).toBe(true);
    expect(api.manifest.importLinkExisting).not.toHaveBeenCalled();
  });

  it('a large same-hash group (5 duplicates) uploads bytes exactly once and links the other four', async () => {
    vi.mocked(api.manifest.importUploadFile).mockResolvedValue({
      asset: makeAsset('shared-id'), linked: false, subAssemblyId: 'sa-0', createdSubAssemblyIds: ['sa-0'],
    });
    vi.mocked(api.manifest.importLinkExisting).mockImplementation(async () => ({
      asset: makeAsset('shared-id'), linked: true, subAssemblyId: 'sa-n', createdSubAssemblyIds: [],
    }));

    const resolutions: ImportResolution[] = [
      { kind: 'new-upload', file: makeFile('dup.stl'), segments: ['Branch 0'] },
      ...Array.from({ length: 4 }, (_, i) => ({
        kind: 'batch-link' as const, file: makeFile('dup.stl'), segments: [`Branch ${i + 1}`], representativeIndex: 0,
      })),
    ];
    const plan: ImportPlan = {
      projectId: 'proj-1', parentSubAssemblyId: null, folderName: 'Pack',
      resolutions, newSubAssemblyTotal: 5, mergedSubAssemblyTotal: 0,
    };

    await startImport(plan);

    expect(api.manifest.importUploadFile).toHaveBeenCalledTimes(1);
    expect(api.manifest.importLinkExisting).toHaveBeenCalledTimes(4);
  });
});

describe('importStore — cancel semantics', () => {
  it('cancel stops claiming new tasks but leaves already-completed placements as done', async () => {
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => { resolveFirst = r; });

    vi.mocked(api.manifest.importUploadFile).mockImplementation(async () => {
      await gate;
      return { asset: makeAsset('a'), linked: false, subAssemblyId: 'sa', createdSubAssemblyIds: [] };
    });

    const resolutions: ImportResolution[] = Array.from({ length: 10 }, (_, i) => ({
      kind: 'new-upload' as const, file: makeFile(`f${i}.stl`), segments: [],
    }));
    const plan: ImportPlan = {
      projectId: 'proj-1', parentSubAssemblyId: null, folderName: 'Big',
      resolutions, newSubAssemblyTotal: 0, mergedSubAssemblyTotal: 0,
    };

    const done = startImport(plan);
    cancelImport();
    resolveFirst();
    await done;

    const s = getSnapshot();
    expect(s.phase).toBe('done');
    // Cancellation stops the pool from claiming further work; not every
    // item is guaranteed to have run, so pending items must not be
    // reported as errors (that would misrepresent "never attempted" as
    // "failed").
    expect(s.items.some((i) => i.status === 'error')).toBe(false);
  });
});

describe('importStore — subscribers', () => {
  it('notifies subscribers as items progress', async () => {
    vi.mocked(api.manifest.importUploadFile).mockResolvedValue({
      asset: makeAsset('a'), linked: false, subAssemblyId: null, createdSubAssemblyIds: [],
    });
    const seen: string[] = [];
    const unsub = subscribe(() => { seen.push(getSnapshot().phase); });

    const plan: ImportPlan = {
      projectId: 'proj-1', parentSubAssemblyId: null, folderName: 'X',
      resolutions: [{ kind: 'new-upload', file: makeFile('x.stl'), segments: [] }],
      newSubAssemblyTotal: 0, mergedSubAssemblyTotal: 0,
    };
    await startImport(plan);
    unsub();

    expect(seen).toContain('committing');
    expect(seen[seen.length - 1]).toBe('done');
  });
});
