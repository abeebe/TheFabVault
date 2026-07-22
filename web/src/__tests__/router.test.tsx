// Router smoke tests for #2156 (Phase A3: react-router shell + VaultPage
// extraction). These deliberately stay shallow — confirming the route
// table wires the right top-level view to the right path — not a deep
// integration test of VaultPage's own behavior (unchanged from before the
// router, and out of scope for this ticket).
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from '../components/AppShell.js';

// The real `api` module makes network calls VaultPage's data hooks kick
// off on mount (assets/folders/projects/sets/stats/trash). None of that
// is under test here, so stub every member VaultPage's mount path touches
// with an immediately-resolved empty result — keeps the test deterministic
// and network-free regardless of environment fetch support.
vi.mock('../lib/api.js', () => ({
  api: {
    health: () => Promise.resolve({ authRequired: false }),
    assets: {
      list: () => Promise.resolve({ items: [], total: 0 }),
      stats: () => Promise.resolve({ total: 0, totalSize: 0, favorites: 0, threeDmodel: 0, twoD: 0, uncategorized: 0 }),
      rethumbFailed: () => Promise.resolve({ queued: 0 }),
      moveToFolder: () => Promise.resolve(),
    },
    folders: { list: () => Promise.resolve([]) },
    projects: { list: () => Promise.resolve([]), addAssets: () => Promise.resolve() },
    sets: { list: () => Promise.resolve([]), addAssets: () => Promise.resolve() },
    trash: { list: () => Promise.resolve({ items: [], total: 0 }) },
  },
}));

beforeEach(() => {
  cleanup();
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

  it('renders the Library placeholder at /library (not VaultPage)', () => {
    renderAt('/library');
    expect(screen.getByText(/model-centric library/i)).toBeTruthy();
    expect(screen.queryByText('All Files')).toBeNull();
  });

  it('renders the Model placeholder at /models/:id with the id threaded through', () => {
    renderAt('/models/abc123');
    expect(screen.getByText(/Model page for id "abc123"/)).toBeTruthy();
  });

  it('renders the persistent nav switch on every route', () => {
    renderAt('/library');
    expect(screen.getByRole('link', { name: 'Library' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vault' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Projects' })).toBeTruthy();
  });
});
