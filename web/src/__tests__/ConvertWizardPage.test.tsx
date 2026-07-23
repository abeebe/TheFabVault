// Wizard coverage for the #2175 rework of the folder→model convert
// wizard. Replaces the #2170 flat-list/multi-select test suite: the
// picker is now a tree (bare-GUID leaves hidden), selection is a single
// anchor folder, and there are two modes (A: recursive single model, B:
// each named child -> its own model, atomic batch). See
// ConvertWizardPage.tsx's file header for the full rationale.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConvertWizardPage } from '../views/ConvertWizardPage.js';
import type {
  FolderConversionPreviewOut, FolderConversionResultEntry, FolderConversionBatchOut,
  ModelOut, ModelDetailOut,
} from '../lib/api.js';
import type { FolderOut } from '../types/index.js';

const mockFoldersList = vi.fn();
const mockModelsList = vi.fn();
const mockPreviewFromFolder = vi.fn();
const mockFromFolder = vi.fn();
const mockFromFolderEachChild = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    folders: { list: (...args: unknown[]) => mockFoldersList(...args) },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
      previewFromFolder: (...args: unknown[]) => mockPreviewFromFolder(...args),
      fromFolder: (...args: unknown[]) => mockFromFolder(...args),
      fromFolderEachChild: (...args: unknown[]) => mockFromFolderEachChild(...args),
    },
  },
}));

function folder(id: string, name: string, parentId: string | null = null, isBareGuid = false): FolderOut {
  return {
    id, name, parentId, createdAt: 0, isBareGuid,
  };
}

function entry(overrides: Partial<FolderConversionResultEntry>): FolderConversionResultEntry {
  // suggestedTitle defaults to whatever sourceFolderName the caller
  // passed (falling back to 'Dragon Prints' if neither is given) so a
  // test that only overrides sourceFolderName doesn't end up with a
  // rendered title input that silently still says 'Dragon Prints'.
  const sourceFolderName = overrides.sourceFolderName ?? 'Dragon Prints';
  return {
    sourceFolderId: 'f1',
    sourceFolderName,
    suggestedTitle: sourceFolderName,
    assetCount: 3,
    countsByRole: { part: 1, image: 1, doc: 1, other: 0 },
    files: [
      { assetId: 'a-stl', filename: 'body.stl', role: 'part' as const, sortOrder: 0 },
      { assetId: 'a-png', filename: 'cover.png', role: 'image' as const, sortOrder: 1 },
      { assetId: 'a-txt', filename: 'readme.txt', role: 'doc' as const, sortOrder: 2 },
    ],
    coverAssetId: 'a-png',
    alreadyConverted: false,
    existingModelIds: [],
    ...overrides,
  };
}

// Mode 'single' preview — results always has exactly one entry, mirrored
// onto the back-compat flat fields (api/src/routes/models.ts's handler
// guarantees this for the default mode).
function singlePreview(overrides: Partial<FolderConversionResultEntry> = {}): FolderConversionPreviewOut {
  const e = entry(overrides);
  return {
    mode: 'single',
    folderId: e.sourceFolderId,
    folderName: e.sourceFolderName,
    suggestedTitle: e.suggestedTitle,
    assetCount: e.assetCount,
    countsByRole: e.countsByRole,
    files: e.files,
    coverAssetId: e.coverAssetId,
    alreadyConverted: e.alreadyConverted,
    existingModelIds: e.existingModelIds,
    results: [e],
    skippedChildren: [],
    looseAssetCount: 0,
  };
}

function eachChildPreview(opts: {
  folderId?: string;
  folderName?: string;
  results?: FolderConversionResultEntry[];
  skippedChildren?: FolderConversionPreviewOut['skippedChildren'];
  looseAssetCount?: number;
}): FolderConversionPreviewOut {
  return {
    mode: 'each-child',
    folderId: opts.folderId ?? 'container1',
    folderName: opts.folderName ?? 'Droidkyn',
    results: opts.results ?? [],
    skippedChildren: opts.skippedChildren ?? [],
    looseAssetCount: opts.looseAssetCount ?? 0,
  };
}

function modelOut(overrides: Partial<ModelOut>): ModelOut {
  return {
    id: 'm1', title: 'X', description: null, categoryId: null, tags: [],
    ownerId: null, visibility: 'public', coverAssetId: null, coverThumbUrl: null,
    sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
    fileCount: 0, likeCount: 0, likedByMe: false, createdAt: 0, updatedAt: 0, deletedAt: null,
    ...overrides,
  };
}

function modelDetailOut(overrides: Partial<ModelDetailOut>): ModelDetailOut {
  return { ...modelOut(overrides), files: [], profiles: [], ...overrides };
}

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={['/convert']}>
      <ConvertWizardPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockFoldersList.mockReset();
  mockModelsList.mockReset();
  mockPreviewFromFolder.mockReset();
  mockFromFolder.mockReset();
  mockFromFolderEachChild.mockReset();
  mockModelsList.mockResolvedValue({ items: [], total: 0 });
});

afterEach(cleanup);

describe('ConvertWizardPage — select step (tree)', () => {
  it('hides a bare-GUID folder as a pickable row, but shows its named sibling', async () => {
    mockFoldersList.mockResolvedValue([
      folder('named1', 'Dragon Prints'),
      folder('guid1', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', null, true),
    ]);
    renderWizard();

    expect(await screen.findByText('Dragon Prints')).toBeTruthy();
    expect(screen.queryByText('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeNull();
  });

  it('hides a bare-GUID CHILD folder while still surfacing its named parent as expandable', async () => {
    mockFoldersList.mockResolvedValue([
      folder('parent1', 'Droidkyn'),
      folder('guidchild', 'a1b2c3d4-e5f6-4789-a012-3456789abcde', 'parent1', true),
      folder('namedchild', 'Chassis', 'parent1'),
    ]);
    renderWizard();

    await screen.findByText('Droidkyn');
    // Expand Droidkyn by clicking its chevron (first button in its row).
    const row = screen.getByText('Droidkyn').closest('div')!.parentElement!;
    const chevronButton = within(row).getAllByRole('button')[0];
    fireEvent.click(chevronButton);

    expect(await screen.findByText('Chassis')).toBeTruthy();
    expect(screen.queryByText('a1b2c3d4-e5f6-4789-a012-3456789abcde')).toBeNull();
  });

  // Kit's review finding on the first cut of this file: a bare-GUID
  // folder that itself CONTAINS a named descendant was hidden outright,
  // same as a genuine bare-GUID leaf — which made the named descendant
  // completely unreachable (the GUID node never rendered, so it never
  // got a chance to expand into its own children). Fix: render such a
  // folder as a non-pickable pass-through ("(unnamed folder)") that's
  // still expandable, so anything named underneath stays reachable.
  it('renders a bare-GUID folder with a named descendant as an expandable, non-pickable pass-through — the named child stays reachable and selectable', async () => {
    mockFoldersList.mockResolvedValue([
      folder('guidparent', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', null, true),
      folder('namedchild', 'Chassis', 'guidparent'),
    ]);
    renderWizard();

    // The pass-through container is NOT hidden (unlike a genuine leaf) —
    // it renders, just relabeled instead of showing the raw GUID.
    expect(await screen.findByText('(unnamed folder)')).toBeTruthy();
    expect(screen.queryByText('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBeNull();
    // Chassis isn't visible yet — the pass-through starts collapsed.
    expect(screen.queryByText('Chassis')).toBeNull();

    // Clicking the pass-through row drills in (not selects — it has no
    // Preview button consequence of its own).
    fireEvent.click(screen.getByText('(unnamed folder)'));
    expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull();

    // Chassis is now reachable AND actually selectable.
    expect(await screen.findByText('Chassis')).toBeTruthy();
    fireEvent.click(screen.getByText('Chassis'));
    expect(await screen.findByRole('button', { name: /Preview/ })).toBeTruthy();
  });

  it('stays reachable through MULTIPLE nested bare-GUID pass-through layers before reaching a named folder', async () => {
    mockFoldersList.mockResolvedValue([
      folder('guid1', '11111111-1111-4111-8111-111111111111', null, true),
      folder('guid2', '22222222-2222-4222-8222-222222222222', 'guid1', true),
      folder('deep', 'Deeply Nested Part', 'guid2'),
    ]);
    renderWizard();

    // Starts collapsed — only guid1 (the root) is visible until expanded.
    expect(await screen.findAllByText('(unnamed folder)')).toHaveLength(1);

    fireEvent.click(screen.getByText('(unnamed folder)')); // expand guid1 -> reveals guid2
    // guid2 is ALSO a pass-through (it has a named descendant of its
    // own) — two "(unnamed folder)" rows now, proving the descendant
    // check works transitively across multiple bare-GUID hops, not just
    // one level.
    const passThroughsAfterFirstExpand = await screen.findAllByText('(unnamed folder)');
    expect(passThroughsAfterFirstExpand).toHaveLength(2);
    fireEvent.click(passThroughsAfterFirstExpand[1]); // expand guid2 -> reveals Deeply Nested Part

    expect(await screen.findByText('Deeply Nested Part')).toBeTruthy();
    fireEvent.click(screen.getByText('Deeply Nested Part'));
    expect(await screen.findByRole('button', { name: /Preview/ })).toBeTruthy();
  });

  it('still fully hides a bare-GUID folder with NO named descendant anywhere in its subtree (regression check — genuine leaves are unaffected by the pass-through fix)', async () => {
    mockFoldersList.mockResolvedValue([
      folder('guidleaf', '4f2504e0-4f89-11d3-9a0c-0305e82c3302', null, true),
      folder('guidgrandchild', '5f2504e0-4f89-11d3-9a0c-0305e82c3303', 'guidleaf', true), // also bare-GUID, no named descendant either
    ]);
    mockModelsList.mockResolvedValue({ items: [], total: 0 });
    renderWizard();

    // Nothing named anywhere -> the picker's own "no named folders" message.
    expect(await screen.findByText('No named folders in the vault yet.')).toBeTruthy();
    expect(screen.queryByText('(unnamed folder)')).toBeNull();
  });

  it('shows an already-converted badge sourced from GET /models on the matching tree row', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints'), folder('f2', 'Skull Planter')]);
    mockModelsList.mockResolvedValue({ items: [modelOut({ id: 'existing1', sourceFolderId: 'f1' })], total: 1 });

    renderWizard();
    await screen.findByText('Dragon Prints');
    expect(await screen.findByText(/Converted/)).toBeTruthy();
    const skullRow = screen.getByText('Skull Planter').closest('div')!.parentElement!;
    expect(within(skullRow).queryByText(/Converted/)).toBeNull();
  });

  it('reveals the mode toggle and Preview button only after a folder is selected', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    renderWizard();
    await screen.findByText('Dragon Prints');

    expect(screen.queryByRole('button', { name: /Preview/ })).toBeNull();
    fireEvent.click(screen.getByText('Dragon Prints'));
    expect(await screen.findByRole('button', { name: /Preview/ })).toBeTruthy();
    expect(screen.getByText(/This folder → 1 model/)).toBeTruthy();
    expect(screen.getByText(/Each named subfolder → its own model/)).toBeTruthy();
  });
});

describe('ConvertWizardPage — mode toggle drives which preview is fetched', () => {
  it('defaults to mode single and requests it on Preview', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(singlePreview());
    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByText('Dragon Prints'));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    await waitFor(() => expect(mockPreviewFromFolder).toHaveBeenCalledWith('f1', 'single'));
  });

  it('requests mode each-child after toggling to it before Preview', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Droidkyn')]);
    mockPreviewFromFolder.mockResolvedValue(eachChildPreview({}));
    renderWizard();
    await screen.findByText('Droidkyn');
    fireEvent.click(screen.getByText('Droidkyn'));
    fireEvent.click(screen.getByText(/Each named subfolder → its own model/));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    await waitFor(() => expect(mockPreviewFromFolder).toHaveBeenCalledWith('f1', 'each-child'));
  });
});

describe('ConvertWizardPage — Mode A (single) review + confirm', () => {
  it('preview shows exactly one resulting model with title/counts/cover', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(singlePreview());

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByText('Dragon Prints'));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    expect(await screen.findByDisplayValue('Dragon Prints')).toBeTruthy();
    expect(await screen.findByText('1 Part')).toBeTruthy();
    expect(await screen.findByText('1 Image')).toBeTruthy();
    expect(await screen.findByText('1 Doc')).toBeTruthy();
    expect(await screen.findByText(/Cover: cover\.png/)).toBeTruthy();
    // Only one model card — no "N models will be created" batch framing.
    expect(screen.queryByText(/models will be created/)).toBeNull();
  });

  it('blocks Confirm on an empty folder', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Empty')]);
    mockPreviewFromFolder.mockResolvedValue(singlePreview({
      assetCount: 0, files: [], countsByRole: { part: 0, image: 0, doc: 0, other: 0 }, coverAssetId: null,
    }));

    renderWizard();
    await screen.findByText('Empty');
    fireEvent.click(screen.getByText('Empty'));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    expect(await screen.findByText(/No convertible files/)).toBeTruthy();
    const confirmButton = await screen.findByRole('button', { name: /Confirm & convert/ }) as HTMLButtonElement;
    expect(confirmButton.textContent).toContain('Confirm & convert 0 models');
    expect(confirmButton.disabled).toBe(true);
  });

  it('requires an explicit re-check before an already-converted folder counts toward confirm', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(singlePreview({ alreadyConverted: true, existingModelIds: ['existing1'] }));

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByText('Dragon Prints'));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    const confirmButton = await screen.findByRole('button', { name: /Confirm & convert/ }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /Convert again anyway/ }));
    await waitFor(() => expect(confirmButton.disabled).toBe(false));
  });

  it('confirms, calls fromFolder with mode single, and navigates to results with a link to the new model', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(singlePreview());
    mockFromFolder.mockResolvedValue(modelDetailOut({ id: 'new-model-1', sourceFolderId: 'f1' }));

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByText('Dragon Prints'));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm & convert 1 model/ }));

    await waitFor(() => expect(mockFromFolder).toHaveBeenCalledWith('f1', undefined, 'single'));
    expect(await screen.findByText('Step 3 of 3 — Results')).toBeTruthy();
    const link = await screen.findByRole('link', { name: /View model/ });
    expect(link.getAttribute('href')).toBe('/models/new-model-1');
  });

  it('shows a retryable error banner and stays on review when the commit rejects', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(singlePreview());
    mockFromFolder.mockRejectedValue(new Error('folder has no assets to convert'));

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByText('Dragon Prints'));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm & convert 1 model/ }));

    expect(await screen.findByText('folder has no assets to convert')).toBeTruthy();
    expect(screen.queryByText('Step 3 of 3 — Results')).toBeNull();
  });
});

describe('ConvertWizardPage — Mode B (each-child) review + confirm', () => {
  // The load-bearing mutation-check test: a Mode B preview with a
  // skipped bare-GUID child, a named-but-empty child, AND loose direct
  // assets must SHOW all three exclusion facts verbatim, not merely
  // compute them and drop them. A mutant that stops rendering the
  // exclusions panel (or drops one of its three sources) fails this.
  it('preview shows N eligible child models AND surfaces every exclusion honestly', async () => {
    mockFoldersList.mockResolvedValue([folder('container1', 'Droidkyn')]);
    mockPreviewFromFolder.mockResolvedValue(eachChildPreview({
      folderId: 'container1',
      folderName: 'Droidkyn',
      results: [
        entry({ sourceFolderId: 'chassis', sourceFolderName: 'Chassis' }),
        entry({
          sourceFolderId: 'turret', sourceFolderName: 'Turret', assetCount: 1,
          countsByRole: { part: 1, image: 0, doc: 0, other: 0 },
          files: [{ assetId: 'a-turret', filename: 'turret.stl', role: 'part', sortOrder: 0 }],
          coverAssetId: null,
        }),
        entry({
          sourceFolderId: 'emptypart', sourceFolderName: 'EmptyPart', assetCount: 0,
          countsByRole: { part: 0, image: 0, doc: 0, other: 0 }, files: [], coverAssetId: null,
        }),
      ],
      skippedChildren: [{ folderId: 'guid1', folderName: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', reason: 'bare-guid-leaf' }],
      looseAssetCount: 1,
    }));

    renderWizard();
    await screen.findByText('Droidkyn');
    fireEvent.click(screen.getByText('Droidkyn'));
    fireEvent.click(screen.getByText(/Each named subfolder → its own model/));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    // Two eligible children (Chassis, Turret) — EmptyPart has 0 assets
    // and is excluded from the "will be created" count.
    expect(await screen.findByText('2 models will be created:')).toBeTruthy();
    expect(await screen.findByDisplayValue('Chassis')).toBeTruthy();
    expect(await screen.findByDisplayValue('Turret')).toBeTruthy();
    expect(screen.queryByDisplayValue('EmptyPart')).toBeNull();

    // All three exclusion categories, verbatim.
    expect(await screen.findByText(/1 GUID-named folder.*skipped/)).toBeTruthy();
    expect(screen.getByText(/3f2504e0-4f89-11d3-9a0c-0305e82c3301/)).toBeTruthy();
    expect(screen.getByText(/1 named subfolder.*no.*convertible files/)).toBeTruthy();
    expect(screen.getByText(/EmptyPart/)).toBeTruthy();
    expect(screen.getByText(/1 loose file/)).toBeTruthy();
    expect(screen.getByText(/not converted by this mode/)).toBeTruthy();
  });

  it('confirms, calls fromFolderEachChild, and produces converted + skipped-empty + skipped-bare-guid result rows', async () => {
    mockFoldersList.mockResolvedValue([folder('container1', 'Droidkyn')]);
    mockPreviewFromFolder.mockResolvedValue(eachChildPreview({
      folderId: 'container1',
      folderName: 'Droidkyn',
      results: [
        entry({ sourceFolderId: 'chassis', sourceFolderName: 'Chassis' }),
        entry({
          sourceFolderId: 'emptypart', sourceFolderName: 'EmptyPart', assetCount: 0,
          countsByRole: { part: 0, image: 0, doc: 0, other: 0 }, files: [], coverAssetId: null,
        }),
      ],
      skippedChildren: [{ folderId: 'guid1', folderName: 'guid-leaf-1', reason: 'bare-guid-leaf' }],
      looseAssetCount: 0,
    }));
    const batch: FolderConversionBatchOut = {
      mode: 'each-child',
      created: [modelDetailOut({ id: 'model-chassis', sourceFolderId: 'chassis', title: 'Chassis' })],
      skippedChildren: [{ folderId: 'guid1', folderName: 'guid-leaf-1', reason: 'bare-guid-leaf' }],
    };
    mockFromFolderEachChild.mockResolvedValue(batch);

    renderWizard();
    await screen.findByText('Droidkyn');
    fireEvent.click(screen.getByText('Droidkyn'));
    fireEvent.click(screen.getByText(/Each named subfolder → its own model/));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm & convert 1 model/ }));

    await waitFor(() => expect(mockFromFolderEachChild).toHaveBeenCalledWith('container1', undefined));
    expect(await screen.findByText('Step 3 of 3 — Results')).toBeTruthy();

    const link = await screen.findByRole('link', { name: /View model/ });
    expect(link.getAttribute('href')).toBe('/models/model-chassis');
    expect(screen.getByText('EmptyPart')).toBeTruthy();
    expect(screen.getByText(/Skipped — no convertible files/)).toBeTruthy();
    expect(screen.getByText('guid-leaf-1')).toBeTruthy();
    expect(screen.getByText(/Skipped — GUID-named folder/)).toBeTruthy();
  });

  // Kit's #2175 fold-in review finding: the singleEntry crash (fixed by
  // gating it on mode==='single') only actually reproduces when Mode
  // B's results[] is EMPTY — every other Mode B test above has at least
  // one entry, so none of them would have caught a regression here.
  // This drives that exact path (zero eligible named children — every
  // immediate child is bare-GUID) all the way through a full render.
  it('Mode B on a container with ZERO eligible named children (all bare-GUID) renders fully without crashing, in a sensible all-excluded state', async () => {
    mockFoldersList.mockResolvedValue([folder('container1', 'OnlyGuids')]);
    mockPreviewFromFolder.mockResolvedValue(eachChildPreview({
      folderId: 'container1',
      folderName: 'OnlyGuids',
      results: [],
      skippedChildren: [
        { folderId: 'g1', folderName: 'guid-1', reason: 'bare-guid-leaf' },
        { folderId: 'g2', folderName: 'guid-2', reason: 'bare-guid-leaf' },
      ],
      looseAssetCount: 0,
    }));

    renderWizard();
    await screen.findByText('OnlyGuids');
    fireEvent.click(screen.getByText('OnlyGuids'));
    fireEvent.click(screen.getByText(/Each named subfolder → its own model/));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    expect(await screen.findByText('This folder has no named subfolders — nothing to convert.')).toBeTruthy();
    expect(screen.getByText(/2 GUID-named folders skipped/)).toBeTruthy();
    const confirmButton = await screen.findByRole('button', { name: /Confirm & convert 0 models/ }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
  });

  it('is all-or-nothing on already-converted children — blocks Confirm until every eligible child is re-checked', async () => {
    mockFoldersList.mockResolvedValue([folder('container1', 'Droidkyn')]);
    mockPreviewFromFolder.mockResolvedValue(eachChildPreview({
      results: [
        entry({ sourceFolderId: 'chassis', sourceFolderName: 'Chassis', alreadyConverted: true, existingModelIds: ['old1'] }),
        entry({ sourceFolderId: 'turret', sourceFolderName: 'Turret' }),
      ],
    }));

    renderWizard();
    await screen.findByText('Droidkyn');
    fireEvent.click(screen.getByText('Droidkyn'));
    fireEvent.click(screen.getByText(/Each named subfolder → its own model/));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));

    const confirmButton = await screen.findByRole('button', { name: /Confirm & convert 2 models/ }) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(screen.getByText(/already converted.*check.*Convert again anyway/)).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: /Convert again anyway/ }));
    await waitFor(() => expect(confirmButton.disabled).toBe(false));
  });

  it('shows a retryable error banner and stays on review when the atomic batch commit rejects', async () => {
    mockFoldersList.mockResolvedValue([folder('container1', 'Droidkyn')]);
    mockPreviewFromFolder.mockResolvedValue(eachChildPreview({
      results: [entry({ sourceFolderId: 'chassis', sourceFolderName: 'Chassis' })],
    }));
    mockFromFolderEachChild.mockRejectedValue(new Error('No eligible child folder has convertible assets'));

    renderWizard();
    await screen.findByText('Droidkyn');
    fireEvent.click(screen.getByText('Droidkyn'));
    fireEvent.click(screen.getByText(/Each named subfolder → its own model/));
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm & convert 1 model/ }));

    expect(await screen.findByText('No eligible child folder has convertible assets')).toBeTruthy();
    expect(screen.queryByText('Step 3 of 3 — Results')).toBeNull();
  });
});
