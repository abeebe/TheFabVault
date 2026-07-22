// Router smoke tests for #2156 (Phase A3: react-router shell + VaultPage
// extraction), #2157 (Phase A4: real LibraryPage/ModelPage replacing the
// #2156 placeholders), and #2168 (Phase B2: Browse landing flip -- / is
// now BrowsePage, Vault moved to /vault only, /library redirects to /,
// theme toggle + logout moved into AppShell's persistent nav). These
// deliberately stay shallow — confirming the route table wires the right
// top-level view to the right path — not a deep integration test of
// VaultPage/BrowsePage/ModelPage's own behavior (see BrowsePage.test.tsx
// for the browse-specific param-building coverage).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '../components/AppShell.js';
import type { ModelDetailOut } from '../lib/api.js';

// mockAssetsList is a vi.fn() (not an inline arrow) specifically so the
// pagination test below can override its resolved value per-test (default
// total: 0 keeps every other test's page-1-of-1 case pagination-free, since
// the pagination controls only render when totalPages > 1).
const mockAssetsList = vi.fn((..._args: unknown[]) => Promise.resolve({ items: [] as unknown[], total: 0 }));
const mockModelsList = vi.fn((..._args: unknown[]) => Promise.resolve({ items: [] as unknown[], total: 0 }));
const mockModelGet = vi.fn((..._args: unknown[]) => Promise.resolve({} as ModelDetailOut));
const mockCategoriesList = vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[]));
const mockCollectionsList = vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[]));
const mockCollectionGet = vi.fn((..._args: unknown[]) => Promise.resolve({} as unknown));

const emptyModelDetail: ModelDetailOut = {
  id: 'abc123', title: 'Widget X', description: null, categoryId: null, tags: [],
  ownerId: null, visibility: 'public', coverAssetId: null, coverThumbUrl: null,
  sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
  fileCount: 0, likeCount: 0, likedByMe: false, createdAt: 0, updatedAt: 0, deletedAt: null, files: [], profiles: [],
};

// The real `api` module makes network calls VaultPage's/BrowsePage's/
// ModelPage's data hooks kick off on mount (assets/folders/projects/sets/
// stats/trash/models/categories). None of that is under test here, so
// stub every member their mount paths touch with an immediately-resolved
// empty result — keeps the test deterministic and network-free regardless
// of environment fetch support.
vi.mock('../lib/api.js', () => ({
  api: {
    health: () => Promise.resolve({ authRequired: false }),
    assets: {
      list: (...args: unknown[]) => mockAssetsList(...args),
      stats: () => Promise.resolve({ total: 0, totalSize: 0, favorites: 0, threeDmodel: 0, twoD: 0, uncategorized: 0 }),
      rethumbFailed: () => Promise.resolve({ queued: 0 }),
      moveToFolder: () => Promise.resolve(),
      thumbUrl: () => null,
      fileUrl: () => '',
    },
    folders: { list: () => Promise.resolve([]) },
    projects: { list: () => Promise.resolve([]), addAssets: () => Promise.resolve() },
    sets: { list: () => Promise.resolve([]), addAssets: () => Promise.resolve() },
    trash: { list: () => Promise.resolve({ items: [], total: 0 }) },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
      get: (...args: unknown[]) => mockModelGet(...args),
      create: () => Promise.resolve({ id: 'new1' }),
      coverThumbUrl: () => null,
      downloadUrl: () => '',
    },
    categories: {
      list: (...args: unknown[]) => mockCategoriesList(...args),
    },
    collections: {
      list: (...args: unknown[]) => mockCollectionsList(...args),
      get: (...args: unknown[]) => mockCollectionGet(...args),
      create: () => Promise.resolve({ id: 'newcol1' }),
      coverThumbUrl: () => null,
    },
  },
}));

beforeEach(() => {
  cleanup();
  mockAssetsList.mockClear();
  mockAssetsList.mockImplementation(() => Promise.resolve({ items: [], total: 0 }));
  mockModelsList.mockClear();
  mockModelsList.mockImplementation(() => Promise.resolve({ items: [], total: 0 }));
  mockModelGet.mockClear();
  mockModelGet.mockImplementation(() => Promise.resolve(emptyModelDetail));
  mockCategoriesList.mockClear();
  mockCategoriesList.mockImplementation(() => Promise.resolve([]));
  mockCollectionsList.mockClear();
  mockCollectionsList.mockImplementation(() => Promise.resolve([]));
  mockCollectionGet.mockClear();
  mockCollectionGet.mockImplementation(() => Promise.resolve({
    id: 'col1', name: 'My Collection', description: null, ownerId: null, visibility: 'public',
    coverModelId: null, coverThumbUrl: null, modelCount: 0, createdAt: 0, models: [],
  }));
  // Pin an explicit theme so useTheme's 'system' default doesn't depend on
  // matchMedia support in the test environment.
  localStorage.setItem('mv_theme', 'light');
});

function renderAt(path: string, authRequired = false) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell logout={() => {}} authRequired={authRequired} />
    </MemoryRouter>
  );
}

describe('AppShell routing', () => {
  it('renders the Browse landing page at / (#2168 landing flip)', async () => {
    renderAt('/');
    // The models search placeholder is BrowsePage-specific — confirms /
    // now renders Browse, not VaultPage (which would show "All Files") or
    // the old LibraryPage placeholder. "Browse" itself appears twice (nav
    // link + breadcrumb span), which is its own additional confirmation —
    // asserted via getAllByText below rather than findByText/getByText
    // (which throw on multiple matches).
    expect(screen.getByPlaceholderText('Search models...')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Browse').length).toBeGreaterThan(0));
    expect(screen.queryByText('All Files')).toBeNull();
  });

  it('renders VaultPage at /vault (no longer aliased at /)', () => {
    renderAt('/vault');
    expect(screen.getAllByText('All Files').length).toBeGreaterThan(0);
  });

  it('redirects /library to / (Browse), #2168', async () => {
    renderAt('/library');
    expect(await screen.findByPlaceholderText('Search models...')).toBeTruthy();
    expect(screen.getAllByText('Browse').length).toBeGreaterThan(0);
  });

  it('renders the real ModelPage at /models/:id with the id threaded through to the fetch, #2157', async () => {
    renderAt('/models/abc123');
    // Title comes from the fetched detail record, proving the :id param
    // actually reached api.models.get (not the #2156 placeholder's
    // "Model page for id ... — coming soon" static string).
    expect(await screen.findByText('Widget X')).toBeTruthy();
    expect(mockModelGet).toHaveBeenCalledWith('abc123');
    expect(screen.queryByText(/coming soon/i)).toBeNull();
  });

  it('renders the persistent nav switch on every route', () => {
    renderAt('/vault');
    expect(screen.getByRole('link', { name: 'Browse' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Collections' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vault' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeTruthy();
  });

  // #2169 (Phase B3): Collections list + detail added as top-level routes,
  // same shape as Browse/ModelPage's own smoke coverage above -- confirms
  // the route table wires the right view to the right path, not a deep
  // test of CollectionsPage/CollectionPage's own behavior (see
  // CollectionsPage.test.tsx / CollectionPage.test.tsx for that).
  it('renders CollectionsPage at /collections', async () => {
    renderAt('/collections');
    expect(await screen.findByRole('button', { name: /new collection/i })).toBeTruthy();
    expect(mockCollectionsList).toHaveBeenCalled();
  });

  it('renders CollectionPage at /collections/:id with the id threaded through to the fetch', async () => {
    renderAt('/collections/col1');
    expect(await screen.findByText('My Collection')).toBeTruthy();
    expect(mockCollectionGet).toHaveBeenCalledWith('col1');
  });

  // Nav affordances (#2168): theme toggle + logout used to live in
  // VaultPage's header (only reachable from /vault); they now live in
  // AppShell's persistent nav, so they must render identically regardless
  // of which route is active. authRequired: true so the logout button
  // actually renders (it's conditional on that flag, same as before the
  // move) -- theme toggle isn't conditional, so it's checked at every path
  // regardless.
  describe('theme toggle + logout render on every route (#2168 nav restructure)', () => {
    it.each(['/', '/vault', '/models/abc123', '/collections'])('on %s', async (path) => {
      renderAt(path, true);
      await waitFor(() => expect(screen.getByTitle(/^Theme:/)).toBeTruthy());
      expect(screen.getByTitle('Sign out')).toBeTruthy();
    });
  });

  it('hides the logout button when authRequired is false', () => {
    renderAt('/vault', false);
    expect(screen.queryByTitle('Sign out')).toBeNull();
  });

  it('shows the logout button when authRequired is true', () => {
    renderAt('/vault', true);
    expect(screen.getByTitle('Sign out')).toBeTruthy();
  });
});

// Regression coverage for the pagination drift Kit caught in review (#2156):
// the extraction had silently relabeled the real "Next" button "Last" and
// dropped the actual jump-to-last button entirely. A label/handler mismatch
// like that doesn't trip tsc or a snapshot of unrelated text, so this
// asserts both the visible label AND the click behavior of each button —
// label-only or handler-only coverage would each have missed half of what
// actually broke. Moved to render at /vault (#2168): VaultPage (and its
// pagination bar) no longer lives at / after the landing flip.
describe('VaultPage pagination controls', () => {
  it('has a working Next button (advances one page) and Last button (jumps to the final page)', async () => {
    // total: 250 with PAGE_SIZE 100 (VaultPage.tsx) -> totalPages = 3,
    // which is what makes the pagination bar render at all.
    mockAssetsList.mockImplementation(() => Promise.resolve({ items: [], total: 250 }));
    renderAt('/vault');

    const nextButton = await screen.findByRole('button', { name: 'Next' });
    const lastButton = screen.getByRole('button', { name: 'Last' });
    // The bug under regression made a single button carry the label "Last"
    // while running the Next handler — assert both are simultaneously
    // present and distinct so that mislabeling collapses back to one.
    expect(nextButton).not.toBe(lastButton);

    const callsBeforeNext = mockAssetsList.mock.calls.length;
    fireEvent.click(nextButton);
    await waitFor(() => expect(mockAssetsList.mock.calls.length).toBeGreaterThan(callsBeforeNext));
    const lastCallAfterNext = mockAssetsList.mock.calls.at(-1) as unknown[];
    const paramsAfterNext = lastCallAfterNext[0] as { offset: number };
    // Page 0 -> page 1: offset advances by exactly one PAGE_SIZE (100).
    expect(paramsAfterNext.offset).toBe(100);

    const callsBeforeLast = mockAssetsList.mock.calls.length;
    fireEvent.click(lastButton);
    await waitFor(() => expect(mockAssetsList.mock.calls.length).toBeGreaterThan(callsBeforeLast));
    const lastCallAfterLast = mockAssetsList.mock.calls.at(-1) as unknown[];
    const paramsAfterLast = lastCallAfterLast[0] as { offset: number };
    // Jumps straight to totalPages - 1 (page 2 of 3) — offset 200, not a
    // single-page increment from wherever Next left off.
    expect(paramsAfterLast.offset).toBe(200);
  });
});
