// View smoke coverage for CollectionsPage (#2169, Phase B3). Router smoke
// (which top-level view mounts at which path) lives in router.test.tsx;
// this file is scoped to CollectionsPage's own contract -- list render,
// empty state, and the create-collection affordance -- mirroring
// BrowsePage.test.tsx's landing-smoke shape at a scope appropriate to how
// much simpler this page is (no search/sort/category params to round-trip).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { CollectionsPage } from '../views/CollectionsPage.js';
import type { CollectionOut } from '../lib/api.js';

const mockList = vi.fn();
const mockCreate = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    collections: {
      list: (...args: unknown[]) => mockList(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      coverThumbUrl: () => null,
    },
  },
}));

const collectionA: CollectionOut = {
  id: 'c1', name: 'Dragons', description: null, ownerId: null, visibility: 'public',
  coverModelId: null, coverThumbUrl: null, modelCount: 4, createdAt: 0,
};

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([collectionA]);
  mockCreate.mockReset().mockResolvedValue({ id: 'c2', name: 'New One' });
});

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/collections']}>
      <Routes>
        <Route path="/collections" element={<CollectionsPage />} />
        {/* Create navigates to the new collection's detail route -- a
            trivial stand-in avoids a "No routes matched" console warning
            for that navigation; CollectionPage's own behavior is covered
            in CollectionPage.test.tsx, not re-tested here. */}
        <Route path="/collections/:id" element={<div>Collection detail placeholder</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('CollectionsPage', () => {
  it('renders the collection list with name and model count', async () => {
    renderPage();
    expect(await screen.findByText('Dragons')).toBeTruthy();
    // "4 models" renders twice in CollectionCard's markup (the no-thumb
    // fallback icon area, plus the info row below it) -- same duplication
    // ModelCard has for fileCount. Asserting presence, not uniqueness.
    expect(screen.getAllByText('4 models').length).toBeGreaterThan(0);
  });

  it('shows an empty state when there are no collections', async () => {
    mockList.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No collections yet')).toBeTruthy();
  });

  it('opens the New Collection modal and creates a collection on submit', async () => {
    renderPage();
    await screen.findByText('Dragons');

    fireEvent.click(screen.getByRole('button', { name: /new collection/i }));
    const input = await screen.findByPlaceholderText(/dragon miniatures/i);
    fireEvent.change(input, { target: { value: 'New One' } });
    fireEvent.click(screen.getByRole('button', { name: /^create collection$/i }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith({ name: 'New One' }));
  });

  it('surfaces a fetch error with a retry affordance', async () => {
    mockList.mockRejectedValue(new Error('boom'));
    renderPage();
    expect(await screen.findByText(/Failed to load collections: boom/)).toBeTruthy();
  });
});
