// Router smoke tests for #2156 (Phase A3: react-router shell + VaultPage
// extraction) and #2157 (Phase A4: real LibraryPage/ModelPage replacing
// the #2156 placeholders). These deliberately stay shallow — confirming
// the route table wires the right top-level view to the right path — not
// a deep integration test of VaultPage/LibraryPage/ModelPage's own
// behavior.
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

const emptyModelDetail: ModelDetailOut = {
  id: 'abc123', title: 'Widget X', description: null, categoryId: null, tags: [],
  ownerId: null, visibility: 'public', coverAssetId: null, coverThumbUrl: null,
  sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
  fileCount: 0, likeCount: 0, likedByMe: false, createdAt: 0, updatedAt: 0, deletedAt: null, files: [], profiles: [],
};

// The real `api` module makes network calls VaultPage's/LibraryPage's/
// ModelPage's data hooks kick off on mount (assets/folders/projects/sets/
// stats/trash/models). None of that is under test here, so stub every
// member their mount paths touch with an immediately-resolved empty
// result — keeps the test deterministic and network-free regardless of
// environment fetch support.
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
      coverThumbUrl: () => null,
      downloadUrl: () => '',
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
  // Pin an explicit theme so useTheme's 'system' default doesn't depend on
  // matchMedia support in the test environment.
  localStorage.setItem('mv_theme', 'light');
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell logout={() => {}} authRequired={false} />
    </MemoryRouter>
  );
}

describe('AppShell routing', () => {
  it('renders VaultPage at /', () => {
    renderAt('/');
    // "All Files" is VaultPage's default breadcrumb/sidebar root — appears
    // twice (sidebar button + breadcrumb span), which is itself confirmation
    // this is the real VaultPage and not a stand-in.
    expect(screen.getAllByText('All Files').length).toBeGreaterThan(0);
  });

  it('renders VaultPage at /vault', () => {
    renderAt('/vault');
    expect(screen.getAllByText('All Files').length).toBeGreaterThan(0);
  });

  it('renders the real LibraryPage at /library (not VaultPage), #2157', async () => {
    renderAt('/library');
    // "New model" + the search placeholder are LibraryPage-specific --
    // confirms this is the real page from #2157, not the #2156 placeholder
    // ("model-centric library ... coming soon") or VaultPage.
    expect(await screen.findByRole('button', { name: /new model/i })).toBeTruthy();
    expect(screen.getByPlaceholderText('Search models...')).toBeTruthy();
    expect(screen.queryByText('All Files')).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
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
    renderAt('/library');
    expect(screen.getByRole('link', { name: 'Library' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vault' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeTruthy();
  });
});

// Regression coverage for the pagination drift Kit caught in review (#2156):
// the extraction had silently relabeled the real "Next" button "Last" and
// dropped the actual jump-to-last button entirely. A label/handler mismatch
// like that doesn't trip tsc or a snapshot of unrelated text, so this
// asserts both the visible label AND the click behavior of each button —
// label-only or handler-only coverage would each have missed half of what
// actually broke.
describe('VaultPage pagination controls', () => {
  it('has a working Next button (advances one page) and Last button (jumps to the final page)', async () => {
    // total: 250 with PAGE_SIZE 100 (VaultPage.tsx) -> totalPages = 3,
    // which is what makes the pagination bar render at all.
    mockAssetsList.mockImplementation(() => Promise.resolve({ items: [], total: 250 }));
    renderAt('/');

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
