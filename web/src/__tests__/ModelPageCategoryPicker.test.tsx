// Smoke coverage for #2164's ModelPage wiring: Edit Details' categoryId
// field is now a <select> fed by useCategories()/GET-categories, not a
// free-text input. Kept as its own file rather than folded into
// ModelPage.test.tsx (that file is scoped to the sourceUrl XSS
// regression and mocks only api.models/api.assets -- adding
// api.categories there would blur what each file is guarding).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ModelPage } from '../views/ModelPage.js';
import type { ModelDetailOut } from '../lib/api.js';

const mockGet = vi.fn();
const mockUpdate = vi.fn();
const mockCategoriesList = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    models: {
      get: (...args: unknown[]) => mockGet(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      downloadUrl: () => '',
    },
    assets: {
      thumbUrl: () => null,
      fileUrl: () => '',
    },
    categories: {
      list: (...args: unknown[]) => mockCategoriesList(...args),
    },
  },
}));

function baseModel(overrides: Partial<ModelDetailOut>): ModelDetailOut {
  return {
    id: 'm1', title: 'Widget X', description: null, categoryId: null, tags: [],
    ownerId: null, visibility: 'public', coverAssetId: null, coverThumbUrl: null,
    sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
    fileCount: 0, likeCount: 0, likedByMe: false, createdAt: 0, updatedAt: 0, deletedAt: null, files: [], profiles: [],
    ...overrides,
  };
}

function renderModelPage() {
  return render(
    <MemoryRouter initialEntries={['/models/m1']}>
      <Routes>
        <Route path="/models/:id" element={<ModelPage />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockGet.mockReset();
  mockUpdate.mockReset().mockResolvedValue(baseModel({}));
  mockCategoriesList.mockReset();
});

afterEach(cleanup);

describe('ModelPage Edit Details -- category picker (#2164)', () => {
  it('renders a select populated from useCategories, with a nested category indented', async () => {
    mockGet.mockResolvedValue(baseModel({ categoryId: null }));
    mockCategoriesList.mockResolvedValue([
      { id: 'cat-1', name: 'Toys & Games', parentId: null, sortOrder: 0 },
      { id: 'cat-2', name: 'Miniatures', parentId: null, sortOrder: 1 },
      { id: 'cat-3', name: 'Dragons', parentId: 'cat-2', sortOrder: 0 },
    ]);
    renderModelPage();

    await screen.findByText('Widget X');
    fireEvent.click(screen.getByTitle('Edit details'));

    const select = await screen.findByLabelText('Category') as HTMLSelectElement;
    await waitFor(() => {
      expect(select.options.length).toBe(4); // Uncategorized + 3 categories
    });

    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toEqual(['Uncategorized', 'Toys & Games', 'Miniatures', '— Dragons']);
  });

  it('sends the selected categoryId through update() on save', async () => {
    mockGet.mockResolvedValue(baseModel({ categoryId: null }));
    mockCategoriesList.mockResolvedValue([
      { id: 'cat-1', name: 'Toys & Games', parentId: null, sortOrder: 0 },
    ]);
    renderModelPage();

    await screen.findByText('Widget X');
    fireEvent.click(screen.getByTitle('Edit details'));

    const select = await screen.findByLabelText('Category') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));

    fireEvent.change(select, { target: { value: 'cat-1' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('m1', expect.objectContaining({ categoryId: 'cat-1' }));
    });
  });

  it('defaults to Uncategorized when the model has no categoryId, and preselects an existing one', async () => {
    mockGet.mockResolvedValue(baseModel({ categoryId: 'cat-1' }));
    mockCategoriesList.mockResolvedValue([
      { id: 'cat-1', name: 'Toys & Games', parentId: null, sortOrder: 0 },
    ]);
    renderModelPage();

    await screen.findByText('Widget X');
    fireEvent.click(screen.getByTitle('Edit details'));

    const select = await screen.findByLabelText('Category') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(select.value).toBe('cat-1');
  });
});
