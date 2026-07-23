// Regression coverage for #2186: ModelPage's carousel only ever looked at
// role='image' files, so a model with zero uploaded images showed an
// empty "No images yet" gallery even when its STL/3MF parts already have
// auto-generated render thumbnails (thumb_status='done'). This pins the
// fallback -- gallery falls back to done-thumb part files when there are
// no image-role files, and still prefers real images outright when both
// exist -- the same way ModelPage.test.tsx pins the sourceUrl XSS fix and
// ModelPage.ownership.test.tsx pins the D4 gating matrix, each scoped to
// its own ticket rather than piling onto one shared file.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ModelPage } from '../views/ModelPage.js';
import type { ModelDetailOut, ModelFileOut } from '../lib/api.js';

const mockGet = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    models: {
      get: (...args: unknown[]) => mockGet(...args),
      downloadUrl: () => '',
      like: () => Promise.resolve({ likeCount: 0, likedByMe: false }),
      unlike: () => Promise.resolve({ likeCount: 0, likedByMe: false }),
    },
    assets: {
      // Real thumbUrl semantics: null unless the asset has one -- mirrors
      // api.ts's own "no asset.thumbUrl -> null" short-circuit, which is
      // exactly the branch that decides whether a file is gallery-worthy.
      thumbUrl: (asset: { thumbUrl: string | null }) => asset.thumbUrl,
      fileUrl: (asset: { id: string }) => `/file/${asset.id}`,
    },
    collections: {
      list: () => Promise.resolve([]),
    },
  },
}));

function makeFile(overrides: Omit<Partial<ModelFileOut>, 'asset'> & { asset: Partial<ModelFileOut['asset']> }): ModelFileOut {
  const filename = overrides.asset.filename ?? 'part.stl';
  return {
    assetId: overrides.asset.id ?? 'a1',
    role: 'part',
    sortOrder: 0,
    label: null,
    ...overrides,
    asset: {
      id: 'a1', filename, originalName: filename, mime: 'application/octet-stream', size: 100,
      folderId: null, tags: [], notes: null, thumbStatus: 'none', thumbUrl: null, url: '/asset/a1',
      meta: {}, createdAt: 0, category: null, deletedAt: null, rating: null, isFavorite: false,
      ...overrides.asset,
    },
  };
}

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

beforeEach(() => { mockGet.mockReset(); });
afterEach(cleanup);

describe('ModelPage gallery -- no-images fallback to part render thumbnails (#2186)', () => {
  it('shows "No images yet" when there are no images AND no done-thumb parts', async () => {
    mockGet.mockResolvedValue(baseModel({
      files: [makeFile({ role: 'part', asset: { id: 'p1', thumbStatus: 'none', thumbUrl: null } })],
    }));
    renderModelPage();

    expect(await screen.findByText('No images yet')).toBeTruthy();
  });

  it('falls back to a done-thumb part file when the model has zero image-role files', async () => {
    mockGet.mockResolvedValue(baseModel({
      files: [
        makeFile({ role: 'part', asset: { id: 'p1', filename: 'body.stl', thumbStatus: 'done', thumbUrl: '/thumb/p1.jpg' } }),
      ],
    }));
    renderModelPage();

    expect(screen.queryByText('No images yet')).toBeNull();
    const img = (await screen.findByAltText('body.stl')) as HTMLImageElement;
    expect(img.src).toContain('/thumb/p1.jpg');
  });

  it('ignores part files without a done thumbnail (pending/failed/none) -- still shows the empty state', async () => {
    mockGet.mockResolvedValue(baseModel({
      files: [
        makeFile({ role: 'part', asset: { id: 'p1', thumbStatus: 'pending', thumbUrl: null } }),
        makeFile({ role: 'part', asset: { id: 'p2', thumbStatus: 'failed', thumbUrl: null } }),
      ],
    }));
    renderModelPage();

    expect(await screen.findByText('No images yet')).toBeTruthy();
  });

  it('prefers real image-role files outright over part thumbnails when both exist', async () => {
    mockGet.mockResolvedValue(baseModel({
      files: [
        makeFile({
          role: 'part', asset: { id: 'p1', filename: 'body.stl', thumbStatus: 'done', thumbUrl: '/thumb/p1.jpg' },
        }),
        makeFile({
          role: 'image', assetId: 'i1',
          asset: { id: 'i1', filename: 'photo.jpg', originalName: 'photo.jpg', thumbStatus: 'done', thumbUrl: '/thumb/i1.jpg' },
        }),
      ],
    }));
    renderModelPage();

    const img = (await screen.findByAltText('photo.jpg')) as HTMLImageElement;
    expect(img.src).toContain('/thumb/i1.jpg');
    expect(screen.queryByAltText('body.stl')).toBeNull();
  });

  it('clicking a fallback part thumbnail opens the same preview handoff a real image would (ModelViewer mounts)', async () => {
    mockGet.mockResolvedValue(baseModel({
      files: [
        makeFile({ role: 'part', asset: { id: 'p1', filename: 'body.stl', thumbStatus: 'done', thumbUrl: '/thumb/p1.jpg' } }),
      ],
    }));
    renderModelPage();

    const img = await screen.findByAltText('body.stl');
    fireEvent.click(img);
    // ModelViewer's modal renders the asset's filename as its title bar --
    // same handoff PartsQuickView already relies on for parts with no
    // thumbnail at all, confirmed here for the gallery's new fallback path.
    expect(await screen.findAllByText('body.stl')).not.toHaveLength(0);
  });
});
