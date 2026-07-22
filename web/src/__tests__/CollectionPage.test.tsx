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
import { MeProvider } from '../hooks/useMe.js';
import type { CollectionDetailOut, ModelOut, AuthMeOut } from '../lib/api.js';

const mockGet = vi.fn();
const mockDelete = vi.fn();
const mockRemoveModel = vi.fn();
const mockReorderModels = vi.fn();
const mockSetCover = vi.fn();
const mockAddModels = vi.fn();
const mockModelsList = vi.fn();
const mockNavigate = vi.fn();
// Phase D4 (#2180): CollectionPage now gates its mutation affordances on
// isOwnerOrAdmin(collection.ownerId, me). Every pre-D4 test in this file
// asserts the "everything is reachable" shape, which is exactly what an
// admin should still see -- so this file's default identity is admin,
// same convention router.test.tsx uses. The dedicated "member-mode
// gating" describe below overrides it per-case.
const mockMe = vi.fn((..._args: unknown[]) => Promise.resolve<AuthMeOut>({
  id: 'admin1', username: 'root', displayName: null, role: 'admin',
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../lib/api.js', () => ({
  api: {
    auth: {
      me: (...args: unknown[]) => mockMe(...args),
    },
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
  mockMe.mockReset();
  mockMe.mockResolvedValue({ id: 'admin1', username: 'root', displayName: null, role: 'admin' });
});

afterEach(cleanup);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/collections/c1']}>
      <MeProvider isAuthenticated={true}>
        <Routes><Route path="/collections/:id" element={<CollectionPage />} /></Routes>
      </MeProvider>
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

    // findAllByTitle (not getAllByTitle) -- these buttons are additionally
    // gated on the async useMe() identity fetch resolving admin/owner
    // (#2180), a second async boundary independent of mockGet's.
    const upButtons = await screen.findAllByTitle('Move earlier');
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

    const upButtons = await screen.findAllByTitle('Move earlier') as HTMLButtonElement[];
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

    fireEvent.click(await screen.findByTitle('Set as cover'));
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

    fireEvent.click(await screen.findByTitle('Cover image (click to clear)'));
    await waitFor(() => expect(mockSetCover).toHaveBeenCalledWith('c1', null));
  });

  it('removing a model calls removeModel with the collection and model id', async () => {
    mockGet.mockResolvedValue(baseCollection({
      modelCount: 1,
      models: [baseModel({ id: 'm1', title: 'First' })],
    }));
    renderPage();
    await screen.findByText('First');

    fireEvent.click(await screen.findByTitle('Remove from collection'));
    await waitFor(() => expect(mockRemoveModel).toHaveBeenCalledWith('c1', 'm1'));
  });

  it('deleting the collection requires confirmation, then navigates back to /collections', async () => {
    mockGet.mockResolvedValue(baseCollection({}));
    renderPage();
    await screen.findByText('Dragons');

    fireEvent.click(await screen.findByTitle('Delete collection'));
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

    fireEvent.click(await screen.findByRole('button', { name: /add models/i }));
    expect(await screen.findByText('Add models to collection')).toBeTruthy();
    await waitFor(() => expect(mockModelsList).toHaveBeenCalled());
  });
});

// Phase D4 (#2180) ownership gating: name/description edit, add-models,
// delete, and per-member reorder/cover/remove are owner-or-admin only.
// Every test above runs as an admin (this file's default mockMe); these
// cover the two other points on the matrix -- a plain member with no
// relationship to the collection, and a member who owns it.
describe('CollectionPage ownership gating (#2180)', () => {
  it('a non-owner member sees no edit affordances (name/desc/add/delete/reorder/cover/remove)', async () => {
    mockMe.mockResolvedValue({ id: 'member1', username: 'bob', displayName: null, role: 'member' });
    mockGet.mockResolvedValue(baseCollection({
      ownerId: 'someone-else', modelCount: 1,
      models: [baseModel({ id: 'm1', title: 'First' })],
    }));
    renderPage();
    await screen.findByText('Dragons');
    await screen.findByText('First');

    expect(screen.queryByRole('button', { name: /add models/i })).toBeNull();
    expect(screen.queryByTitle('Delete collection')).toBeNull();
    expect(screen.queryByTitle('Move earlier')).toBeNull();
    expect(screen.queryByTitle('Move later')).toBeNull();
    expect(screen.queryByTitle('Set as cover')).toBeNull();
    expect(screen.queryByTitle('Remove from collection')).toBeNull();
    // Name/description are plain (non-interactive) text, not a click-to-edit
    // control, for a non-owner member.
    const nameHeading = screen.getByText('Dragons').closest('h1') as HTMLElement;
    expect(nameHeading.className).not.toContain('cursor-pointer');
  });

  it('a member who owns the collection (ownerId matches their id) still sees edit affordances', async () => {
    mockMe.mockResolvedValue({ id: 'owner1', username: 'alice', displayName: null, role: 'member' });
    mockGet.mockResolvedValue(baseCollection({
      ownerId: 'owner1', modelCount: 1,
      models: [baseModel({ id: 'm1', title: 'First' })],
    }));
    renderPage();
    await screen.findByText('Dragons');
    await screen.findByText('First');

    expect(await screen.findByRole('button', { name: /add models/i })).toBeTruthy();
    expect(await screen.findByTitle('Delete collection')).toBeTruthy();
    expect(await screen.findByTitle('Set as cover')).toBeTruthy();
    expect(await screen.findByTitle('Remove from collection')).toBeTruthy();
  });

  // Legacy/pre-ownership rows (created before Phase D) carry owner_id
  // NULL -- per D3's server-side isOwnerOrAdmin (row.owner_id === me.id
  // is always false for a NULL owner_id, since me.id is never null),
  // these are admin-editable only; a member sees them read-only even
  // though nobody else "owns" it either. Client-side canEdit mirrors
  // that exactly (lib/permissions.ts) -- this pins the two sides staying
  // in lockstep.
  it('a NULL-owner_id (legacy) collection is read-only for a member, editable for an admin', async () => {
    mockMe.mockResolvedValue({ id: 'member1', username: 'bob', displayName: null, role: 'member' });
    mockGet.mockResolvedValue(baseCollection({
      ownerId: null, modelCount: 1,
      models: [baseModel({ id: 'm1', title: 'First' })],
    }));
    renderPage();
    await screen.findByText('Dragons');
    await screen.findByText('First');
    expect(screen.queryByTitle('Delete collection')).toBeNull();

    cleanup();
    mockMe.mockResolvedValue({ id: 'admin1', username: 'root', displayName: null, role: 'admin' });
    renderPage();
    await screen.findByText('Dragons');
    expect(await screen.findByTitle('Delete collection')).toBeTruthy();
  });
});
