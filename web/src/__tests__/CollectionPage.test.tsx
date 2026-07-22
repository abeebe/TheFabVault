// View smoke coverage for CollectionPage (#2169, Phase B3) -- the model-
// grouping detail page. Mirrors ModelPage.test.tsx's/SetView's shallow
// per-affordance style: confirms each control (reorder, set cover,
// remove, add-models, delete) calls the right api.collections.* method
// with the right arguments, not a full re-render/re-fetch integration
// test of every state transition.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { CollectionPage } from '../views/CollectionPage.js';
import type { CollectionDetailOut, ModelOut } from '../lib/api.js';

const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockRemoveModel = vi.fn();
const mockReorderModels = vi.fn();
const mockSetCover = vi.fn();
const mockAddModels = vi.fn();
const mockModelsList = vi.fn();
const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../lib/api.js', () => ({
  api: {
    collections: {
      get: (...args: unknown[]) => mockGet(...args),
      delete: (...args: unknown[]) => mockDelete(...args),
      removeModel: (...args: unknown[]) => mockRemoveModel(...args),
      reorderModels: (...args: unknown[]) => mockReorderModels(...args),
      setCover: (...args: unknown[]) => mockSetCover(...args),
      addModels: (...args: unknown[]) => mockAddModels(...args),
      update: () => Promise.resolve({}),
    },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
      coverThumbUrl: () => null,
    },
  },
}));

function baseModel(overrides: Partial<ModelOut>): ModelOut {
  return {
    id: 'm1', title: 'Model One', description: null, categoryId: null, tags: [],
    ownerId: null, visibility: 'public', coverAssetId: null, coverThumbUrl: null,
    sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
    fileCount: 0, likeCount: 0, likedByMe: false, createdAt: 0, updatedAt: 0, deletedAt: null,
    ...overrides,
  };
}

function baseCollection(overrides: Partial<CollectionDetailOut>): CollectionDetailOut {
  return {
    id: 'c1', name: 'Dragons', description: null, ownerId: null, visibility: 'public',
    coverModelId: null, coverThumbUrl: null, modelCount: 0, createdAt: 0, models: [],
    ...overrides,
  };
}

beforeEach(() => {
  mockGet.mockReset();
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockRemoveModel.mockReset().mockResolvedValue(undefined);
  mockReorderModels.mockReset().mockResolvedValue({});
  mockSetCover.mockReset().mockResolvedValue({});
  mockAddModels.mockReset().mockResolvedValue({ added: 1 });
  mockModelsList.mockReset().mockResolvedValue({ items: [], total: 0 });
  mockNavigate.mockReset();
});

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/collections/c1']}>
      <Routes><Route path="/collections/:id" element={<CollectionPage />} /></Routes>
    </MemoryRouter>
  );
}

describe('CollectionPage', () => {
  it('renders the collection name, description, and member grid', async () => {
    mockGet.mockResolvedValue(baseCollection({
      description: 'A dragon-themed set',
      modelCount: 2,
      models: [baseModel({ id: 'm1', title: 'Red Dragon' }), baseModel({ id: 'm2', title: 'Blue Dragon' })],
    }));
    renderPage();

    expect(await screen.findByText('Dragons')).toBeTruthy();
    expect(screen.getByText('A dragon-themed set')).toBeTruthy();
    expect(screen.getByText('Red Dragon')).toBeTruthy();
    expect(screen.getByText('Blue Dragon')).toBeTruthy();
    expect(screen.getByText('(2 models)')).toBeTruthy();
  });

  it('shows an empty state when the collection has no members', async () => {
    mockGet.mockResolvedValue(baseCollection({}));
    renderPage();
    expect(await screen.findByText('This collection is empty')).toBeTruthy();
  });

  it('moving the second model up reorders with it swapped to first', async () => {
    mockGet.mockResolvedValue(baseCollection({
      modelCount: 2,
      models: [baseModel({ id: 'm1', title: 'First' }), baseModel({ id: 'm2', title: 'Second' })],
    }));
    renderPage();
    await screen.findByText('Second');

    const upButtons = screen.getAllByTitle('Move earlier');
    // First model's "move earlier" is disabled; the second model's is the
    // one that does something -- click it.
    fireEvent.click(upButtons[1]);

    await waitFor(() => expect(mockReorderModels).toHaveBeenCalledWith('c1', ['m2', 'm1']));
  });

  it('the first model\'s "move earlier" and last model\'s "move later" are disabled', async () => {
    mockGet.mockResolvedValue(baseCollection({
      modelCount: 2,
      models: [baseModel({ id: 'm1', title: 'First' }), baseModel({ id: 'm2', title: 'Second' })],
    }));
    renderPage();
    await screen.findByText('Second');

    const upButtons = screen.getAllByTitle('Move earlier') as HTMLButtonElement[];
    const downButtons = screen.getAllByTitle('Move later') as HTMLButtonElement[];
    expect(upButtons[0].disabled).toBe(true);
    expect(downButtons[1].disabled).toBe(true);
  });

  it('clicking the star on a non-cover model sets it as cover', async () => {
    mockGet.mockResolvedValue(baseCollection({
      modelCount: 1,
      coverModelId: null,
      models: [baseModel({ id: 'm1', title: 'First' })],
    }));
    renderPage();
    await screen.findByText('First');

    fireEvent.click(screen.getByTitle('Set as cover'));
    await waitFor(() => expect(mockSetCover).toHaveBeenCalledWith('c1', 'm1'));
  });

  it('clicking the star on the current cover model clears it', async () => {
    mockGet.mockResolvedValue(baseCollection({
      modelCount: 1,
      coverModelId: 'm1',
      models: [baseModel({ id: 'm1', title: 'First' })],
    }));
    renderPage();
    await screen.findByText('First');

    fireEvent.click(screen.getByTitle('Cover image (click to clear)'));
    await waitFor(() => expect(mockSetCover).toHaveBeenCalledWith('c1', null));
  });

  it('removing a model calls removeModel with the collection and model id', async () => {
    mockGet.mockResolvedValue(baseCollection({
      modelCount: 1,
      models: [baseModel({ id: 'm1', title: 'First' })],
    }));
    renderPage();
    await screen.findByText('First');

    fireEvent.click(screen.getByTitle('Remove from collection'));
    await waitFor(() => expect(mockRemoveModel).toHaveBeenCalledWith('c1', 'm1'));
  });

  it('deleting the collection requires confirmation, then navigates back to /collections', async () => {
    mockGet.mockResolvedValue(baseCollection({}));
    renderPage();
    await screen.findByText('Dragons');

    fireEvent.click(screen.getByTitle('Delete collection'));
    expect(await screen.findByText('Delete collection?')).toBeTruthy();
    expect(mockDelete).not.toHaveBeenCalled();

    // Two elements now share the accessible name "Delete collection" --
    // the header's icon-only button (title attribute) and the modal's
    // confirm button (text content). The confirm button is the one that
    // appeared after opening the modal, i.e. the last match.
    const confirmButtons = screen.getAllByRole('button', { name: /^delete collection$/i });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/collections'));
  });

  it('opening "Add models" mounts the ModelPicker, which searches api.models.list', async () => {
    mockGet.mockResolvedValue(baseCollection({}));
    renderPage();
    await screen.findByText('Dragons');

    fireEvent.click(screen.getByRole('button', { name: /add models/i }));
    expect(await screen.findByText('Add models to collection')).toBeTruthy();
    await waitFor(() => expect(mockModelsList).toHaveBeenCalled());
  });
});
