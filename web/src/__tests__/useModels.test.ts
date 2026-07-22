// Param-building + mutation-forwarding tests for useModels/useModel (A4,
// #2157). These stay shallow -- confirming the hooks pass params/ids/
// bodies through to api.models.* and refetch after a mutation -- not
// re-testing api.ts itself or the server (that's Sage's contract-drift
// territory). Mirrors useAssets.ts's shape closely enough that most of
// these assertions double as regression coverage for that shared pattern
// (JSON.stringify-keyed refetch, no-op-when-id-is-null guards).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useModels, useModel } from '../hooks/useModels.js';
import type { ModelDetailOut } from '../lib/api.js';

const mockList = vi.fn();
const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockAttachExisting = vi.fn();
const mockDetachFile = vi.fn();
const mockSetCover = vi.fn();
const mockCreateProfile = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    models: {
      list: (...args: unknown[]) => mockList(...args),
      get: (...args: unknown[]) => mockGet(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      attachExisting: (...args: unknown[]) => mockAttachExisting(...args),
      detachFile: (...args: unknown[]) => mockDetachFile(...args),
      setCover: (...args: unknown[]) => mockSetCover(...args),
      profiles: {
        create: (...args: unknown[]) => mockCreateProfile(...args),
      },
    },
  },
}));

const emptyDetail: ModelDetailOut = {
  id: 'm1', title: 'Test model', description: null, categoryId: null, tags: [],
  ownerId: null, visibility: 'public', coverAssetId: null, coverThumbUrl: null,
  sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
  fileCount: 0, createdAt: 0, updatedAt: 0, deletedAt: null, files: [], profiles: [],
};

beforeEach(() => {
  mockList.mockReset().mockResolvedValue({ items: [], total: 0 });
  mockGet.mockReset().mockResolvedValue(emptyDetail);
  mockUpdate.mockReset().mockResolvedValue({ ...emptyDetail });
  mockAttachExisting.mockReset().mockResolvedValue({ attached: 1, model: emptyDetail });
  mockDetachFile.mockReset().mockResolvedValue(undefined);
  mockSetCover.mockReset().mockResolvedValue(emptyDetail);
  mockCreateProfile.mockReset().mockResolvedValue({});
});

describe('useModels', () => {
  it('passes the given params straight through to api.models.list', async () => {
    const params = { q: 'dragon', sort: 'name_asc' as const, limit: 60, offset: 120 };
    const { result } = renderHook(() => useModels(params));

    await waitFor(() => expect(mockList).toHaveBeenCalledWith(params));
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('re-fetches when params change to different values', async () => {
    const { rerender } = renderHook(({ p }) => useModels(p), {
      initialProps: { p: { limit: 60, offset: 0 } },
    });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    rerender({ p: { limit: 60, offset: 60 } });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(mockList).toHaveBeenLastCalledWith({ limit: 60, offset: 60 });
  });

  it('does not re-fetch when a new params object with identical values is passed (JSON.stringify dep)', async () => {
    const { rerender } = renderHook(({ p }) => useModels(p), {
      initialProps: { p: { limit: 60, offset: 0 } },
    });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(1));

    rerender({ p: { limit: 60, offset: 0 } }); // new object literal, same values
    await new Promise((r) => setTimeout(r, 0));
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected list() call as `error`, and clears loading', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useModels({}));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
  });
});

describe('useModel', () => {
  it('fetches by id and exposes the detail record', async () => {
    const { result } = renderHook(() => useModel('m1'));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('m1'));
    await waitFor(() => expect(result.current.model?.id).toBe('m1'));
  });

  it('does nothing when id is null -- no fetch, model stays null', async () => {
    const { result } = renderHook(() => useModel(null));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.model).toBeNull();
  });

  it('update() forwards id + body to the API, then refetches', async () => {
    const { result } = renderHook(() => useModel('m1'));
    await waitFor(() => expect(result.current.model).not.toBeNull());
    mockGet.mockClear();

    await act(async () => {
      await result.current.update({ title: 'New title' });
    });

    expect(mockUpdate).toHaveBeenCalledWith('m1', { title: 'New title' });
    expect(mockGet).toHaveBeenCalledWith('m1'); // refetch after mutation
  });

  it('attachExisting() forwards assetIds + optional role', async () => {
    const { result } = renderHook(() => useModel('m1'));
    await waitFor(() => expect(result.current.model).not.toBeNull());

    await act(async () => {
      await result.current.attachExisting(['a1', 'a2'], 'image');
    });

    expect(mockAttachExisting).toHaveBeenCalledWith('m1', ['a1', 'a2'], 'image');
  });

  it('detachFile() and setCover() are no-ops when id is null', async () => {
    const { result } = renderHook(() => useModel(null));

    await act(async () => {
      await result.current.detachFile('a1');
      await result.current.setCover('a1');
    });

    expect(mockDetachFile).not.toHaveBeenCalled();
    expect(mockSetCover).not.toHaveBeenCalled();
  });

  it('createProfile() forwards the model id + body', async () => {
    const { result } = renderHook(() => useModel('m1'));
    await waitFor(() => expect(result.current.model).not.toBeNull());

    await act(async () => {
      await result.current.createProfile({ name: 'Draft PLA' });
    });

    expect(mockCreateProfile).toHaveBeenCalledWith('m1', { name: 'Draft PLA' });
  });
});
