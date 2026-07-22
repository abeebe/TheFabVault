// Unit test for hooks/useCategories.ts (#2164) -- mirrors useModels.test.ts's
// shallow "confirm it calls the right api.* method and surfaces the
// result/error" shape, not re-testing api.ts or the server.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCategories } from '../hooks/useCategories.js';

const mockList = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    categories: {
      list: (...args: unknown[]) => mockList(...args),
    },
  },
}));

beforeEach(() => {
  mockList.mockReset();
});

describe('useCategories', () => {
  it('fetches the category list on mount', async () => {
    mockList.mockResolvedValue([
      { id: 'cat-1', name: 'Functional', parentId: null, sortOrder: 0 },
    ]);
    const { result } = renderHook(() => useCategories());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(result.current.categories).toHaveLength(1);
    expect(result.current.categories[0].name).toBe('Functional');
    expect(result.current.error).toBeNull();
  });

  it('surfaces an error and leaves the list empty when the fetch fails', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useCategories());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe('boom');
    expect(result.current.categories).toEqual([]);
  });

  it('refresh() re-fetches', async () => {
    mockList.mockResolvedValue([]);
    const { result } = renderHook(() => useCategories());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await result.current.refresh();
    expect(mockList).toHaveBeenCalledTimes(2);
  });
});
