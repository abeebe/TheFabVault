// Wizard smoke coverage for the bulk folder→model convert wizard
// (#2170). Exercises the full select -> review -> confirm -> results
// loop against a mocked api client, plus the already-converted marker
// (built client-side from GET /models' sourceFolderId, per Derek's
// routing note) and the "skip already-converted unless re-checked"
// idempotence guard routes/models.ts's preview handler backs.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConvertWizardPage } from '../views/ConvertWizardPage.js';
import type { FolderConversionPreviewOut, ModelOut, ModelDetailOut } from '../lib/api.js';

const mockFoldersList = vi.fn();
const mockModelsList = vi.fn();
const mockPreviewFromFolder = vi.fn();
const mockFromFolder = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    folders: { list: (...args: unknown[]) => mockFoldersList(...args) },
    models: {
      list: (...args: unknown[]) => mockModelsList(...args),
      previewFromFolder: (...args: unknown[]) => mockPreviewFromFolder(...args),
      fromFolder: (...args: unknown[]) => mockFromFolder(...args),
    },
  },
}));

function folder(id: string, name: string) {
  return { id, name, parentId: null, createdAt: 0 };
}

function preview(overrides: Partial<FolderConversionPreviewOut>): FolderConversionPreviewOut {
  return {
    folderId: 'f1',
    folderName: 'Dragon Prints',
    suggestedTitle: 'Dragon Prints',
    assetCount: 3,
    countsByRole: { part: 1, image: 1, doc: 1, other: 0 },
    files: [
      { assetId: 'a-stl', filename: 'body.stl', role: 'part', sortOrder: 0 },
      { assetId: 'a-png', filename: 'cover.png', role: 'image', sortOrder: 1 },
      { assetId: 'a-txt', filename: 'readme.txt', role: 'doc', sortOrder: 2 },
    ],
    coverAssetId: 'a-png',
    alreadyConverted: false,
    existingModelIds: [],
    ...overrides,
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
  mockModelsList.mockResolvedValue({ items: [], total: 0 });
});

afterEach(cleanup);

describe('ConvertWizardPage — select step', () => {
  it('lists folders and shows an already-converted badge sourced from GET /models', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints'), folder('f2', 'Skull Planter')]);
    mockModelsList.mockResolvedValue({
      items: [modelOut({ id: 'existing1', sourceFolderId: 'f1' })],
      total: 1,
    });

    renderWizard();

    expect(await screen.findByText('Dragon Prints')).toBeTruthy();
    expect(await screen.findByText(/Already converted/)).toBeTruthy();
    // Skull Planter has no model with sourceFolderId f2 -> no badge on its row.
    const skullRow = screen.getByText('Skull Planter').closest('label')!;
    expect(within(skullRow).queryByText(/Already converted/)).toBeNull();
  });

  it('disables Review until at least one folder is checked', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    renderWizard();
    await screen.findByText('Dragon Prints');

    const reviewButton = screen.getByRole('button', { name: /Review/ }) as HTMLButtonElement;
    expect(reviewButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(reviewButton.disabled).toBe(false);
  });
});

describe('ConvertWizardPage — review step', () => {
  it('fetches a preview per selected folder and shows title/counts/cover', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(preview({}));

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));

    await waitFor(() => expect(mockPreviewFromFolder).toHaveBeenCalledWith('f1'));
    expect(await screen.findByDisplayValue('Dragon Prints')).toBeTruthy();
    expect(await screen.findByText('1 Part')).toBeTruthy();
    expect(await screen.findByText('1 Image')).toBeTruthy();
    expect(await screen.findByText('1 Doc')).toBeTruthy();
    expect(await screen.findByText(/Cover: cover\.png/)).toBeTruthy();
  });

  it('excludes an empty-folder preview from the confirm count', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Empty')]);
    mockPreviewFromFolder.mockResolvedValue(preview({ assetCount: 0, files: [], countsByRole: { part: 0, image: 0, doc: 0, other: 0 }, coverAssetId: null }));

    renderWizard();
    await screen.findByText('Empty');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));

    expect(await screen.findByText(/No convertible assets/)).toBeTruthy();
    const confirmButton = await screen.findByRole('button', { name: /Confirm & convert/ }) as HTMLButtonElement;
    expect(confirmButton.textContent).toContain('Confirm & convert 0 folders');
    expect(confirmButton.disabled).toBe(true);
  });

  it('requires an explicit re-check before an already-converted folder counts toward the batch', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(preview({ alreadyConverted: true, existingModelIds: ['existing1'] }));

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));

    const confirmButton = await screen.findByRole('button', { name: /Confirm & convert/ }) as HTMLButtonElement;
    expect(confirmButton.textContent).toContain('Confirm & convert 0 folders');
    expect(confirmButton.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /Convert again anyway/ }));
    await waitFor(() => expect(confirmButton.textContent).toContain('Confirm & convert 1 folder'));
    expect(confirmButton.disabled).toBe(false);
  });
});

describe('ConvertWizardPage — confirm + results', () => {
  it('converts sequentially and shows a per-folder result row with a link to the new model', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(preview({}));
    mockFromFolder.mockResolvedValue({ id: 'new-model-1' } as ModelDetailOut);

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    const confirmButton = await screen.findByRole('button', { name: /Confirm & convert 1 folder/ });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mockFromFolder).toHaveBeenCalledWith('f1', undefined));
    expect(await screen.findByText('Step 3 of 3 — Results')).toBeTruthy();
    const link = await screen.findByRole('link', { name: /View model/ });
    expect(link.getAttribute('href')).toBe('/models/new-model-1');
  });

  // Regression for Kit's #2170 review finding: a folder whose PREVIEW
  // fetch itself rejects (not the later conversion call) used to fall
  // through both named branches of the results back-fill loop and vanish
  // from Results entirely — even though it was selected, and even though
  // the code's own comment promised every selected folder shows up.
  it('still shows a result row for a folder whose PREVIEW fetch fails, in a mixed batch with a folder that previews fine', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints'), folder('f2', 'Skull Planter')]);
    mockPreviewFromFolder.mockImplementation((folderId: string) => (
      folderId === 'f1'
        ? Promise.resolve(preview({ folderId: 'f1', folderName: 'Dragon Prints' }))
        : Promise.reject(new Error('folder not found'))
    ));
    mockFromFolder.mockResolvedValue({ id: 'new-model-1' } as ModelDetailOut);

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByLabelText('Dragon Prints'));
    fireEvent.click(screen.getByLabelText('Skull Planter'));
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));

    // Only f1 (the folder whose preview succeeded) is eligible — f2's
    // failed preview correctly keeps it out of the batch...
    const confirmButton = await screen.findByRole('button', { name: /Confirm & convert 1 folder/ });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mockFromFolder).toHaveBeenCalledWith('f1', undefined));
    // ...but conversion still ran for f1, so fromFolder must never have
    // been called for f2 (the bug's failure mode was silent omission from
    // Results, not an accidental conversion attempt).
    expect(mockFromFolder).not.toHaveBeenCalledWith('f2', expect.anything());

    expect(await screen.findByText('Step 3 of 3 — Results')).toBeTruthy();
    // The load-bearing assertion: BOTH selected folders appear in
    // Results, not just the one that converted successfully.
    expect(await screen.findByText('Dragon Prints')).toBeTruthy();
    expect(await screen.findByText('Skull Planter')).toBeTruthy();
    expect(await screen.findByText(/Preview failed: folder not found/)).toBeTruthy();
  });

  it('records an error row (not a thrown exception) when one folder in the batch fails', async () => {
    mockFoldersList.mockResolvedValue([folder('f1', 'Dragon Prints')]);
    mockPreviewFromFolder.mockResolvedValue(preview({}));
    mockFromFolder.mockRejectedValue(new Error('folder has no assets to convert'));

    renderWizard();
    await screen.findByText('Dragon Prints');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm & convert 1 folder/ }));

    expect(await screen.findByText('folder has no assets to convert')).toBeTruthy();
  });
});
