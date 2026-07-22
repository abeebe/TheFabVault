// Regression coverage for the stored-XSS finding in Kit's #2157 review:
// ModelPage's "Source attribution" block rendered model.sourceUrl (free
// text, set via the Edit Details modal today and slated to hold
// third-party import metadata once Phase C's zip import lands) as a real
// `<a href>` with no scheme check -- unlike every markdown link, which
// goes through lib/markdown.ts's isSafeUrl. Kit verified a
// `javascript:alert(document.cookie)` sourceUrl landed as a real
// clickable anchor. This pins the fix (same isSafeUrl guard, shared not
// duplicated) the way the #2156 pagination regression test pinned a
// button-mislabeling bug: asserting both the safe and unsafe cases so a
// guard that silently stops applying collapses back to a failure here.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ModelPage } from '../views/ModelPage.js';
import type { ModelDetailOut } from '../lib/api.js';

const mockGet = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
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
    // AddToCollectionMenu (#2169) mounts useCollections on every ModelPage
    // render (to populate its popover), independent of whether the menu
    // is ever opened -- stubbed here so that mount doesn't 404 against an
    // undefined api.collections and spam console.error in every test in
    // this file, none of which touch collections behavior themselves
    // (see AddToCollectionMenu.test.tsx / useCollections.test.ts for that).
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
});

afterEach(cleanup);

describe('ModelPage source attribution -- sourceUrl scheme guard', () => {
  it('renders a safe https sourceUrl as a real, clickable anchor', async () => {
    mockGet.mockResolvedValue(baseModel({ sourceUrl: 'https://printables.com/model/123' }));
    renderModelPage();

    const link = await screen.findByText('https://printables.com/model/123') as unknown as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://printables.com/model/123');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('does NOT render a javascript: sourceUrl as a clickable anchor (XSS regression)', async () => {
    const payload = 'javascript:alert(document.cookie)';
    mockGet.mockResolvedValue(baseModel({ sourceUrl: payload }));
    renderModelPage();

    const el = await screen.findByText(payload);
    expect(el.tagName).not.toBe('A');
    // Belt-and-suspenders: assert no anchor anywhere on the page carries
    // this href, not just that this particular text node isn't one.
    await waitFor(() => {
      const anchors = Array.from(document.querySelectorAll('a'));
      expect(anchors.some((a) => a.getAttribute('href') === payload)).toBe(false);
    });
  });

  it('also guards case-variant and whitespace-padded javascript: schemes', async () => {
    const payload = ' \tJaVaScRiPt:alert(1)';
    mockGet.mockResolvedValue(baseModel({ sourceUrl: payload }));
    renderModelPage();

    // Wait for the real render to complete (not the loading spinner)
    // before asserting the absence of an anchor -- otherwise this would
    // trivially "pass" even if the component crashed or never rendered
    // the attribution block at all.
    await screen.findByText('Widget X');
    const anchors = Array.from(document.querySelectorAll('a'));
    expect(anchors.some((a) => a.getAttribute('href') === payload)).toBe(false);
  });
});
