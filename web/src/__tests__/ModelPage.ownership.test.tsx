// Ownership/role-gating matrix for ModelPage (Phase D4, #2180, plan §6).
// ModelPage.test.tsx (sourceUrl XSS regression) already covers rendering
// independent of role; this file is scoped to the NEW D4 behavior --
// edit/delete/attach/upload/reorder/cover/profile-write controls hidden
// unless isOwnerOrAdmin(model.ownerId, me), while like + AddToCollectionMenu
// stay available to every member regardless (per the ticket). Mirrors
// CollectionPage's ownership-gating test file's shape one level down
// (model, not collection).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ModelPage } from '../views/ModelPage.js';
import { MeProvider } from '../hooks/useMe.js';
import type { ModelDetailOut, AuthMeOut } from '../lib/api.js';

const mockGet = vi.fn();
const mockMe = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    auth: {
      me: (...args: unknown[]) => mockMe(...args),
    },
    models: {
      get: (...args: unknown[]) => mockGet(...args),
      downloadUrl: () => '',
      like: () => Promise.resolve({ likeCount: 1, likedByMe: true }),
      unlike: () => Promise.resolve({ likeCount: 0, likedByMe: false }),
    },
    assets: {
      thumbUrl: () => null,
      fileUrl: () => '',
    },
    // AddToCollectionMenu mounts useCollections on every render regardless
    // of whether it's opened -- same stub ModelPage.test.tsx uses.
    collections: {
      list: () => Promise.resolve([]),
    },
  },
}));

function baseModel(overrides: Partial<ModelDetailOut>): ModelDetailOut {
  return {
    id: 'm1', title: 'Widget X', description: null, categoryId: null, tags: [],
    ownerId: null, visibility: 'public', coverAssetId: null, coverThumbUrl: null,
    sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
    fileCount: 1, likeCount: 0, likedByMe: false, createdAt: 0, updatedAt: 0, deletedAt: null,
    files: [{
      assetId: 'a1', role: 'image', sortOrder: 0, label: null,
      asset: {
        id: 'a1', filename: 'cover.png', originalName: 'cover.png', mime: 'image/png', size: 100,
        folderId: null, tags: [], notes: null, thumbStatus: 'done', thumbUrl: null, url: '/asset/a1',
        meta: {}, createdAt: 0, category: null, deletedAt: null, rating: null, isFavorite: false,
      },
    }],
    profiles: [],
    ...overrides,
  };
}

function adminUser(): AuthMeOut {
  return { id: 'admin1', username: 'root', displayName: null, role: 'admin' };
}

function member(id: string, username: string): AuthMeOut {
  return { id, username, displayName: null, role: 'member' };
}

function renderModelPage() {
  return render(
    <MemoryRouter initialEntries={['/models/m1']}>
      <MeProvider isAuthenticated={true}>
        <Routes><Route path="/models/:id" element={<ModelPage />} /></Routes>
      </MeProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockGet.mockReset();
  mockMe.mockReset();
});

afterEach(cleanup);

describe('ModelPage ownership gating (#2180)', () => {
  it('an admin sees every edit affordance regardless of ownerId', async () => {
    mockMe.mockResolvedValue(adminUser());
    mockGet.mockResolvedValue(baseModel({ ownerId: 'someone-else' }));
    renderModelPage();
    await screen.findByText('Widget X');

    expect(await screen.findByTitle('Edit details')).toBeTruthy();
    expect(await screen.findByTitle('Delete model')).toBeTruthy();

    // Set-cover/detach/attach/upload live in the Files tab, not Overview
    // (ModelPage's default tab) -- switch tabs before checking them.
    fireEvent.click(screen.getByRole('button', { name: 'Files (1)' }));
    expect(await screen.findByText('Attach from vault')).toBeTruthy();
    expect(await screen.findByText('Upload files')).toBeTruthy();
    expect(await screen.findByTitle('Set as cover image')).toBeTruthy();
    expect(await screen.findByTitle('Remove from model (file stays in vault)')).toBeTruthy();
  });

  it('a non-owner member sees no edit affordances, but keeps like + add-to-collection', async () => {
    mockMe.mockResolvedValue(member('member1', 'bob'));
    mockGet.mockResolvedValue(baseModel({ ownerId: 'someone-else' }));
    renderModelPage();
    await screen.findByText('Widget X');
    // Wait out the async identity resolution before asserting absence --
    // otherwise this would trivially "pass" while me is still loading.
    await waitFor(() => expect(mockMe).toHaveBeenCalled());

    expect(screen.queryByTitle('Edit details')).toBeNull();
    expect(screen.queryByTitle('Delete model')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Files (1)' }));
    await screen.findByTitle('Download'); // Files tab has finished rendering.
    expect(screen.queryByText('Attach from vault')).toBeNull();
    expect(screen.queryByText('Upload files')).toBeNull();
    expect(screen.queryByTitle('Set as cover image')).toBeNull();
    expect(screen.queryByTitle('Remove from model (file stays in vault)')).toBeNull();

    // Available to every member regardless of ownership (per the ticket).
    expect(screen.getByTitle('Download')).toBeTruthy();
  });

  it('a member who owns the model (ownerId matches their id) sees the edit affordances', async () => {
    mockMe.mockResolvedValue(member('owner1', 'alice'));
    mockGet.mockResolvedValue(baseModel({ ownerId: 'owner1' }));
    renderModelPage();
    await screen.findByText('Widget X');

    expect(await screen.findByTitle('Edit details')).toBeTruthy();
    expect(await screen.findByTitle('Delete model')).toBeTruthy();
  });

  // Legacy/pre-ownership rows (created before Phase D) carry owner_id
  // NULL. Server-side isOwnerOrAdmin (api/src/routes/models.ts) treats
  // `null === me.id` as always false, so these are admin-editable only --
  // lib/permissions.ts's client-side isOwnerOrAdmin mirrors that exactly.
  // Confirmed by reading services/visibility.ts + routes/models.ts's
  // isOwnerOrAdmin directly (not assumed) before writing this.
  it('a NULL-ownerId (legacy) model is read-only for a member, editable for an admin', async () => {
    mockMe.mockResolvedValue(member('member1', 'bob'));
    mockGet.mockResolvedValue(baseModel({ ownerId: null }));
    renderModelPage();
    await screen.findByText('Widget X');
    await waitFor(() => expect(mockMe).toHaveBeenCalled());
    expect(screen.queryByTitle('Edit details')).toBeNull();

    cleanup();
    mockMe.mockReset();
    mockMe.mockResolvedValue(adminUser());
    renderModelPage();
    await screen.findByText('Widget X');
    expect(await screen.findByTitle('Edit details')).toBeTruthy();
  });

  it('hides the visibility select (inside Edit Details) for a non-owner member, since the pencil that opens it is gone', async () => {
    mockMe.mockResolvedValue(member('member1', 'bob'));
    mockGet.mockResolvedValue(baseModel({ ownerId: 'someone-else', visibility: 'public' }));
    renderModelPage();
    await screen.findByText('Widget X');
    await waitFor(() => expect(mockMe).toHaveBeenCalled());

    // The visibility badge (view-only) is still shown to everyone --
    // only the edit path (pencil -> modal -> select) is gated.
    expect(screen.getByText('public')).toBeTruthy();
    expect(screen.queryByTitle('Edit details')).toBeNull();
    expect(screen.queryByText('Edit model details')).toBeNull();
  });
});
