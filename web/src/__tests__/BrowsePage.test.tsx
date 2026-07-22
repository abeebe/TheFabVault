// Param-building + deep-link round-trip tests for BrowsePage (#2168,
// Phase B2). Router smoke coverage (which top-level view mounts at which
// path) lives in router.test.tsx; this file is scoped to BrowsePage's own
// contract -- search/category/sort state syncs to the URL's query string
// (shareable/bookmarkable browse views) and, in the other direction, a
// URL that already carries those params seeds the initial UI state and
// fetch. Deliberately does not re-test useModels/useCategories themselves
// (see useModels.test.ts / useCategories.test.ts) -- only that BrowsePage
// wires searchParams <-> those hooks' params correctly.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { BrowsePage } from '../views/BrowsePage.js';

const mockModelsList = vi.fn((..._args: unknown[]) => Promise.resolve({ items: [] as unknown[], total: 0 }));
const mockCategoriesList = vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[]));

vi.mock('../lib/api.js', () => ({
  api: {
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
      create: (...args: unknown[]) => Promise.resolve({ id: 'new1' }),
      coverThumbUrl: () => null,
    },
    categories: {
      list: (...args: unknown[]) => mockCategoriesList(...args),
    },
  },
}));

beforeEach(() => {
  mockModelsList.mockClear();
  mockModelsList.mockImplementation(() => Promise.resolve({ items: [], total: 0 }));
  mockCategoriesList.mockClear();
  mockCategoriesList.mockImplementation(() => Promise.resolve([
    { id: 'cat-1', name: 'Miniatures', parentId: null, sortOrder: 0 },
    { id: 'cat-2', name: 'Functional', parentId: null, sortOrder: 1 },
  ]));
});

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<BrowsePage />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('BrowsePage landing smoke', () => {
  it('renders the search box, category chips, sort select, and New model affordance', async () => {
    renderAt('/');
    expect(screen.getByPlaceholderText('Search models...')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Miniatures' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Functional' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /new model/i })).toBeTruthy();
  });

  it('fetches with no filters on a bare landing', async () => {
    renderAt('/');
    await waitFor(() => expect(mockModelsList).toHaveBeenCalled());
    const call = mockModelsList.mock.calls[0][0] as Record<string, unknown>;
    expect(call.q).toBeUndefined();
    expect(call.category).toBeUndefined();
    expect(call.sort).toBe('date_desc');
  });
});

describe('BrowsePage param round-trip (URL <-> state)', () => {
  it('seeds initial state from an incoming URL (bookmarked/shared link)', async () => {
    renderAt('/?q=dragon&category=cat-2&sort=name_asc');

    // Search box reflects ?q=
    const input = screen.getByPlaceholderText('Search models...') as HTMLInputElement;
    expect(input.value).toBe('dragon');

    // Sort select reflects ?sort=
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('name_asc');

    // Category chip reflects ?category= (selected chip is styled active --
    // asserted via the fetch params below, which is what actually matters
    // for correctness of the round trip).
    await waitFor(() => expect(mockModelsList).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'dragon', category: 'cat-2', sort: 'name_asc' }),
    ));
  });

  it('clicking a category chip writes ?category= into the URL and refetches', async () => {
    renderAt('/');
    await screen.findByRole('button', { name: 'Miniatures' });
    mockModelsList.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Miniatures' }));

    await waitFor(() => expect(mockModelsList).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'cat-1' }),
    ));
  });

  it('clicking "All" after a category is selected clears ?category=', async () => {
    renderAt('/?category=cat-1');
    await waitFor(() => expect(mockModelsList).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'cat-1' }),
    ));
    mockModelsList.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));

    await waitFor(() => {
      const call = mockModelsList.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(call.category).toBeUndefined();
    });
  });

  it('changing the sort select writes ?sort= into the URL and refetches', async () => {
    renderAt('/');
    await waitFor(() => expect(mockModelsList).toHaveBeenCalled());
    mockModelsList.mockClear();

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'name_asc' } });

    await waitFor(() => expect(mockModelsList).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'name_asc' }),
    ));
  });

  // #2169 rider (per the routing brief): "likes" sort was deferred out of
  // #2168's scope pending B1 (#2167, collections/likes API); now that B1
  // is in main, it's added as a third sort option here.
  it('supports the "likes" sort option now that B1 has shipped', async () => {
    renderAt('/?sort=likes');

    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('likes');
    await waitFor(() => expect(mockModelsList).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'likes' }),
    ));
  });

  it('debounces search input into ?q= and the fetch, rather than firing per keystroke', async () => {
    renderAt('/');
    await waitFor(() => expect(mockModelsList).toHaveBeenCalled());
    mockModelsList.mockClear();

    const input = screen.getByPlaceholderText('Search models...');
    fireEvent.change(input, { target: { value: 'd' } });
    fireEvent.change(input, { target: { value: 'dr' } });
    fireEvent.change(input, { target: { value: 'dra' } });
    fireEvent.change(input, { target: { value: 'dragon' } });

    // Immediately after typing, the debounce window (300ms) hasn't
    // elapsed yet -- no fetch should have fired for any intermediate value.
    expect(mockModelsList).not.toHaveBeenCalled();

    // Once debounce settles, exactly the final value reaches the fetch --
    // confirms intermediate keystrokes were coalesced, not queued.
    await waitFor(() => expect(mockModelsList).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'dragon' }),
    ), { timeout: 2000 });
    expect(mockModelsList).toHaveBeenCalledTimes(1);
  });
});
