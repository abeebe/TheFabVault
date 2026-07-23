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
