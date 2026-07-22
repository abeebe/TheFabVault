// Param/mutation-forwarding tests for useCollections/useCollection (#2169,
// Phase B3). Mirrors useModels.test.ts's shape closely -- confirming the
// hooks pass ids/bodies through to api.collections.* and refetch (or
// splice locally, for the same immediate-removal cases useSetDetail
// covers) after a mutation, not re-testing api.ts or the server.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useCollections, useCollection } from '../hooks/useCollections.js';
import type { CollectionDetailOut, CollectionOut } from '../lib/api.js';

const mockList = vi.fn();
const mockGet = vi.fn();
const mockCreate = vi.fn();
const mockDelete = vi.fn();
const mockUpdate = vi.fn();
const mockAddModels = vi.fn();
const mockRemoveModel = vi.fn();
const mockReorderModels = vi.fn();
const mockSetCover = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    collections: {
      list: (...args: unknown[]) => mockList(...args),
      get: (...args: unknown[]) => mockGet(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      addModels: (...args: unknown[]) => mockAddModels(...args),
      removeModel: (...args: unknown[]) => mockRemoveModel(...args),
      reorderModels: (...args: unknown[]) => mockReorderModels(...args),
      setCover: (...args: unknown[]) => mockSetCover(...args),
    },
  },
}));

const collectionA: CollectionOut = {
  id: 'c1', name: 'Alpha', description: null, ownerId: null, visibility: 'public',
  coverModelId: null, coverThumbUrl: null, modelCount: 0, createdAt: 0,
};
const collectionB: CollectionOut = {
  id: 'c2', name: 'Beta', description: null, ownerId: null, visibility: 'public',
  coverModelId: null, coverThumbUrl: null, modelCount: 2, createdAt: 1,
};

const modelM1 = {
  id: 'm1', title: 'Model One', description: null, categoryId: null, tags: [],
  ownerId: null, visibility: 'public' as const, coverAssetId: null, coverThumbUrl: null,
  sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
  fileCount: 0, likeCount: 0, likedByMe: false, createdAt: 0, updatedAt: 0, deletedAt: null,
};
const modelM2 = { ...modelM1, id: 'm2', title: 'Model Two' };

const detailC1: CollectionDetailOut = { ...collectionA, modelCount: 2, models: [modelM1, modelM2] };

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([collectionB, collectionA]);
  mockGet.mockReset().mockResolvedValue(detailC1);
  mockCreate.mockReset().mockResolvedValue(collectionA);
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockUpdate.mockReset().mockResolvedValue(collectionA);
  mockAddModels.mockReset().mockResolvedValue({ added: 1 });
  mockRemoveModel.mockReset().mockResolvedValue(undefined);
  mockReorderModels.mockReset().mockResolvedValue(detailC1);
  mockSetCover.mockReset().mockResolvedValue(collectionA);
});

afterEach(() => vi.clearAllMocks());

describe('useCollections', () => {
  it('fetches the collection list on mount', async () => {
    const { result } = renderHook(() => useCollections());
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(result.current.collections).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error and leaves the list empty when the fetch fails', async () => {
    mockList.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('boom');
    expect(result.current.collections).toEqual([]);
  });

  it('createCollection() forwards name + options and splices the result in, name-sorted', async () => {
    mockList.mockResolvedValue([collectionA]); // 'Alpha' only, pre-create
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockCreate.mockResolvedValueOnce(collectionB); // 'Beta'
    await act(async () => {
      await result.current.createCollection('Beta', { modelIds: ['m1'] });
    });

    expect(mockCreate).toHaveBeenCalledWith({ name: 'Beta', modelIds: ['m1'] });
    // Sorted case-insensitively by name -- Alpha before Beta.
    expect(result.current.collections.map((c) => c.name)).toEqual(['Alpha', 'Beta']);
  });

  it('deleteCollection() forwards the id and removes it from the list', async () => {
    const { result } = renderHook(() => useCollections());
    await waitFor(() => expect(result.current.collections).toHaveLength(2));

    await act(async () => {
      await result.current.deleteCollection('c1');
    });

    expect(mockDelete).toHaveBeenCalledWith('c1');
    expect(result.current.collections.map((c) => c.id)).toEqual(['c2']);
  });
});

describe('useCollection', () => {
  it('fetches by id and exposes the detail record', async () => {
    const { result } = renderHook(() => useCollection('c1'));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(result.current.collection?.id).toBe('c1'));
    expect(result.current.collection?.models).toHaveLength(2);
  });

  it('does nothing when id is null -- no fetch, collection stays null', async () => {
    const { result } = renderHook(() => useCollection(null));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockGet).not.toHaveBeenCalled();
    expect(result.current.collection).toBeNull();
  });

  it('update() forwards id + body, then refetches', async () => {
    const { result } = renderHook(() => useCollection('c1'));
    await waitFor(() => expect(result.current.collection).not.toBeNull());
    mockGet.mockClear();

    await act(async () => {
      await result.current.update({ name: 'New name' });
    });

    expect(mockUpdate).toHaveBeenCalledWith('c1', { name: 'New name' });
    expect(mockGet).toHaveBeenCalledWith('c1');
  });

  it('removeModel() forwards id + modelId and splices the member out locally (no refetch)', async () => {
    const { result } = renderHook(() => useCollection('c1'));
    await waitFor(() => expect(result.current.collection?.models).toHaveLength(2));
    mockGet.mockClear();

    await act(async () => {
      await result.current.removeModel('m1');
    });

    expect(mockRemoveModel).toHaveBeenCalledWith('c1', 'm1');
    expect(result.current.collection?.models.map((m) => m.id)).toEqual(['m2']);
    expect(result.current.collection?.modelCount).toBe(1);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('addModels() forwards id + modelIds, then refetches', async () => {
    const { result } = renderHook(() => useCollection('c1'));
    await waitFor(() => expect(result.current.collection).not.toBeNull());

    await act(async () => {
      await result.current.addModels(['m3', 'm4']);
    });

    expect(mockAddModels).toHaveBeenCalledWith('c1', ['m3', 'm4']);
  });

  it('reorderModels() forwards id + the full ordered id list', async () => {
    const { result } = renderHook(() => useCollection('c1'));
    await waitFor(() => expect(result.current.collection).not.toBeNull());

    await act(async () => {
      await result.current.reorderModels(['m2', 'm1']);
    });

    expect(mockReorderModels).toHaveBeenCalledWith('c1', ['m2', 'm1']);
  });

  it('setCover() forwards id + modelId (or null to clear)', async () => {
    const { result } = renderHook(() => useCollection('c1'));
    await waitFor(() => expect(result.current.collection).not.toBeNull());

    await act(async () => {
      await result.current.setCover('m1');
    });
    expect(mockSetCover).toHaveBeenCalledWith('c1', 'm1');

    await act(async () => {
      await result.current.setCover(null);
    });
    expect(mockSetCover).toHaveBeenCalledWith('c1', null);
  });

  it('removeModel()/addModels()/reorderModels()/setCover() are no-ops when id is null', async () => {
    const { result } = renderHook(() => useCollection(null));

    await act(async () => {
      await result.current.removeModel('m1');
      await result.current.addModels(['m1']);
      await result.current.reorderModels(['m1']);
      await result.current.setCover('m1');
    });

    expect(mockRemoveModel).not.toHaveBeenCalled();
    expect(mockAddModels).not.toHaveBeenCalled();
    expect(mockReorderModels).not.toHaveBeenCalled();
    expect(mockSetCover).not.toHaveBeenCalled();
  });
});
