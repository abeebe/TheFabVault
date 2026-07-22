// Wizard coverage for the zip ImportWizard (#2173, Phase C). Exercises
// the full upload -> plan (edit) -> commit -> results loop against a
// mocked api client. Deliberately weighted toward the invariants a
// regression could quietly break: an invalid entry can never reach the
// commit body regardless of what the role map says, excluding a file
// drops it out of both `files` and `profiles`, and the sourceUrl gate
// blocks commit before any network call happens -- each of those is
// asserted via the actual args api.import.commit was called with, not
// just what the UI displays, so a mutation that only changes the
// *display* but not the *submitted payload* would still fail these.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ImportWizardPage } from '../views/ImportWizardPage.js';
import type {
  ZipImportPlan, ZipImportDraftResponse, ZipImportCommitResult, ZipImportCommitBody,
} from '../lib/api.js';

const mockCategoriesList = vi.fn();
const mockUploadZip = vi.fn();
const mockCommit = vi.fn();
const mockAbandon = vi.fn();

vi.mock('../lib/api.js', () => ({
  api: {
    categories: { list: (...args: unknown[]) => mockCategoriesList(...args) },
    import: {
      uploadZip: (...args: unknown[]) => mockUploadZip(...args),
      commit: (...args: unknown[]) => mockCommit(...args),
      abandon: (...args: unknown[]) => mockAbandon(...args),
    },
  },
}));

function plan(overrides: Partial<ZipImportPlan> = {}): ZipImportPlan {
  return {
    suggestedTitle: 'Dragon Prints',
    files: [
      { path: 'Dragon/body.stl', role: 'part', invalid: false, size: 204800 },
      { path: 'Dragon/cover.png', role: 'image', invalid: false, size: 51200 },
      { path: 'Dragon/profiles/print.gcode', role: 'part', invalid: false, size: 10240 },
      { path: 'Dragon/README.md', role: 'doc', invalid: false, size: 512 },
      { path: '../evil.stl', role: 'part', invalid: true, invalidReason: 'path traversal (..)', size: 999 },
      { path: '__MACOSX/._body.stl', role: 'ignore', invalid: false, size: 128 },
    ],
    descriptionSource: 'Dragon/README.md',
    profileCandidates: ['Dragon/profiles/print.gcode'],
    guessedSourceSite: 'printables',
    licenseFile: null,
    ...overrides,
  };
}

function draftResponse(overrides: Partial<ZipImportDraftResponse> = {}): ZipImportDraftResponse {
  return {
    draftId: 'draft-1',
    zipFilename: 'dragon.zip',
    plan: plan(),
    expiresAt: Math.floor(Date.now() / 1000) + 48 * 3600,
    ...overrides,
  };
}

function commitResult(overrides: Partial<ZipImportCommitResult> = {}): ZipImportCommitResult {
  return {
    model: {
      id: 'model-1', title: 'Dragon Prints', description: null, categoryId: null, tags: [],
      ownerId: null, visibility: 'public', coverAssetId: null, coverThumbUrl: null,
      sourceUrl: null, sourceSite: null, sourceAuthor: null, license: null, sourceFolderId: null,
      fileCount: 3, likeCount: 0, likedByMe: false, createdAt: 0, updatedAt: 0, deletedAt: null,
      files: [], profiles: [],
    },
    files: [
      { path: 'Dragon/body.stl', assetId: 'a1', outcome: 'created' },
      { path: 'Dragon/cover.png', assetId: 'a2', outcome: 'linked-existing' },
      { path: 'Dragon/profiles/print.gcode', assetId: 'a1', outcome: 'merged-duplicate' },
    ],
    ...overrides,
  };
}

function renderWizard() {
  return render(
    <MemoryRouter initialEntries={['/import']}>
      <Routes>
        <Route path="/import" element={<ImportWizardPage />} />
        <Route path="/" element={<div>Browse landing</div>} />
        <Route path="/models/:id" element={<div>Model page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function uploadAndReachPlanStep() {
  renderWizard();
  const file = new File(['zipbytes'], 'dragon.zip', { type: 'application/zip' });
  const input = document.getElementById('import-zip-input') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByDisplayValue('Dragon Prints');
}

beforeEach(() => {
  mockCategoriesList.mockReset();
  mockUploadZip.mockReset();
  mockCommit.mockReset();
  mockAbandon.mockReset();
  mockCategoriesList.mockResolvedValue([]);
  mockUploadZip.mockResolvedValue(draftResponse());
  mockAbandon.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe('ImportWizardPage — upload step', () => {
  it('uploads the selected file with an onProgress callback and advances to the plan step on success', async () => {
    await uploadAndReachPlanStep();

    expect(mockUploadZip).toHaveBeenCalledTimes(1);
    const [file, opts] = mockUploadZip.mock.calls[0];
    expect((file as File).name).toBe('dragon.zip');
    expect(typeof opts.onProgress).toBe('function');
    expect(screen.getByText('Step 2 of 3 — Review & edit')).toBeTruthy();
  });

  it('shows an inline error and stays on the upload step when the upload fails', async () => {
    mockUploadZip.mockRejectedValue(new Error('Could not read zip file'));
    renderWizard();
    const file = new File(['bad'], 'bad.zip', { type: 'application/zip' });
    fireEvent.change(document.getElementById('import-zip-input')!, { target: { files: [file] } });

    expect(await screen.findByText('Could not read zip file')).toBeTruthy();
    expect(screen.queryByText('Step 2 of 3 — Review & edit')).toBeNull();
  });
});

describe('ImportWizardPage — plan step round-trip', () => {
  it('prefills title from suggestedTitle, source site from the classifier guess, and defaults the first image as cover', async () => {
    await uploadAndReachPlanStep();

    expect((screen.getByDisplayValue('Dragon Prints') as HTMLInputElement).value).toBe('Dragon Prints');
    expect((screen.getByDisplayValue('Printables') as HTMLInputElement).value).toBe('Printables');

    const coverRadio = screen.getByRole('radio', { name: 'Cover' }) as HTMLInputElement;
    expect(coverRadio.checked).toBe(true);
  });

  it('never renders a row or a role control for the invalid (path-traversal) entry, and shows its reason', async () => {
    await uploadAndReachPlanStep();

    expect(screen.getByText(/Excluded — path traversal/)).toBeTruthy();
    expect(screen.queryByLabelText('Role for evil.stl')).toBeNull();
  });

  it('never renders a row for junk/dir-marker entries, only a summary count', async () => {
    await uploadAndReachPlanStep();

    expect(screen.queryByText('._body.stl')).toBeNull();
    expect(screen.getByText(/1 junk\/directory entry was automatically excluded/)).toBeTruthy();
  });
});

describe('ImportWizardPage — role reassignment + exclude invariant', () => {
  it('reassigning a role changes the committed payload; excluding a file drops it from files AND profiles', async () => {
    await uploadAndReachPlanStep();

    // README.md defaults to 'doc' -- reassign to 'other'.
    fireEvent.change(screen.getByLabelText('Role for README.md'), { target: { value: 'other' } });

    // Exclude the profile-candidate gcode file -- this must ALSO drop it
    // out of the profiles[] array, not just files[], since the server
    // 400s a profile path that isn't also a committed file.
    fireEvent.change(screen.getByLabelText('Role for print.gcode'), { target: { value: 'exclude' } });

    mockCommit.mockResolvedValue(commitResult());
    fireEvent.click(screen.getByRole('button', { name: /Commit 3 files/ }));

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    const [draftId, body] = mockCommit.mock.calls[0] as [string, ZipImportCommitBody];
    expect(draftId).toBe('draft-1');

    const paths = body.files.map((f) => f.path);
    expect(paths).not.toContain('Dragon/profiles/print.gcode');
    expect(paths).toContain('Dragon/README.md');
    expect(body.files.find((f) => f.path === 'Dragon/README.md')?.role).toBe('other');
    expect(body.profiles?.some((p) => p.path === 'Dragon/profiles/print.gcode')).toBe(false);
  });

  it('an invalid entry can never reach the commit body, even though its role/path exist in the plan', async () => {
    await uploadAndReachPlanStep();

    mockCommit.mockResolvedValue(commitResult());
    fireEvent.click(screen.getByRole('button', { name: /Commit 4 files/ }));

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    const [, body] = mockCommit.mock.calls[0] as [string, ZipImportCommitBody];
    expect(body.files.some((f) => f.path === '../evil.stl')).toBe(false);
  });

  it('toggling the profile checkbox off removes that path from profiles[] without affecting files[]', async () => {
    await uploadAndReachPlanStep();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Profile' }));

    mockCommit.mockResolvedValue(commitResult());
    fireEvent.click(screen.getByRole('button', { name: /Commit 4 files/ }));

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    const [, body] = mockCommit.mock.calls[0] as [string, ZipImportCommitBody];
    expect(body.files.some((f) => f.path === 'Dragon/profiles/print.gcode')).toBe(true);
    expect(body.profiles).toEqual([]);
  });

  it('changing role away from image clears that file as cover if it was selected', async () => {
    await uploadAndReachPlanStep();

    fireEvent.change(screen.getByLabelText('Role for cover.png'), { target: { value: 'other' } });
    expect(screen.queryByRole('radio', { name: 'Cover' })).toBeNull();

    mockCommit.mockResolvedValue(commitResult());
    fireEvent.click(screen.getByRole('button', { name: /Commit 4 files/ }));
    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    const [, body] = mockCommit.mock.calls[0] as [string, ZipImportCommitBody];
    expect(body.coverPath).toBeNull();
  });
});

describe('ImportWizardPage — sourceUrl gate', () => {
  it('blocks commit and never calls the API when sourceUrl is an unsafe scheme', async () => {
    await uploadAndReachPlanStep();

    fireEvent.change(screen.getByPlaceholderText('Source URL'), { target: { value: 'javascript:alert(1)' } });

    const commitButton = screen.getByRole('button', { name: /Commit \d+ files?/ }) as HTMLButtonElement;
    expect(commitButton.disabled).toBe(true);

    fireEvent.click(commitButton);
    expect(mockCommit).not.toHaveBeenCalled();
    expect(screen.getByText(/Must be a valid http\(s\)/)).toBeTruthy();
  });

  it('allows a valid https sourceUrl through to commit', async () => {
    await uploadAndReachPlanStep();
    fireEvent.change(screen.getByPlaceholderText('Source URL'), { target: { value: 'https://printables.com/model/1' } });

    mockCommit.mockResolvedValue(commitResult());
    fireEvent.click(screen.getByRole('button', { name: /Commit 4 files/ }));

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    const [, body] = mockCommit.mock.calls[0] as [string, ZipImportCommitBody];
    expect(body.sourceUrl).toBe('https://printables.com/model/1');
  });
});

describe('ImportWizardPage — commit outcome + results step', () => {
  it('renders per-file outcome rows and counts, with a working View model button', async () => {
    await uploadAndReachPlanStep();
    mockCommit.mockResolvedValue(commitResult());
    fireEvent.click(screen.getByRole('button', { name: /Commit 4 files/ }));

    expect(await screen.findByText('Step 3 of 3 — Done')).toBeTruthy();
    expect(screen.getByText('1 Created')).toBeTruthy();
    expect(screen.getByText('1 Linked existing')).toBeTruthy();
    expect(screen.getByText('1 Merged duplicate')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View model' }));
    expect(await screen.findByText('Model page')).toBeTruthy();
  });

  it('surfaces a commit error inline and stays on the plan step so the user can retry', async () => {
    await uploadAndReachPlanStep();
    mockCommit.mockRejectedValue(new Error('title is required'));
    fireEvent.click(screen.getByRole('button', { name: /Commit 4 files/ }));

    expect(await screen.findByText('title is required')).toBeTruthy();
    expect(screen.queryByText('Step 3 of 3 — Done')).toBeNull();
  });
});

describe('ImportWizardPage — cancel + unmount cleanup', () => {
  it('Cancel abandons the draft and navigates back to Browse', async () => {
    await uploadAndReachPlanStep();
    fireEvent.click(screen.getByRole('button', { name: /Cancel import/ }));

    await waitFor(() => expect(mockAbandon).toHaveBeenCalledWith('draft-1'));
    expect(await screen.findByText('Browse landing')).toBeTruthy();
  });

  it('best-effort abandons an in-flight draft if the wizard unmounts without committing or canceling', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/import']}>
        <ImportWizardPage />
      </MemoryRouter>
    );
    const file = new File(['zipbytes'], 'dragon.zip', { type: 'application/zip' });
    fireEvent.change(document.getElementById('import-zip-input')!, { target: { files: [file] } });
    await screen.findByDisplayValue('Dragon Prints');

    unmount();
    await waitFor(() => expect(mockAbandon).toHaveBeenCalledWith('draft-1'));
  });

  it('does NOT abandon again on unmount after a successful commit (draft already deleted server-side)', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/import']}>
        <ImportWizardPage />
      </MemoryRouter>
    );
    const file = new File(['zipbytes'], 'dragon.zip', { type: 'application/zip' });
    fireEvent.change(document.getElementById('import-zip-input')!, { target: { files: [file] } });
    await screen.findByDisplayValue('Dragon Prints');

    mockCommit.mockResolvedValue(commitResult());
    fireEvent.click(screen.getByRole('button', { name: /Commit 4 files/ }));
    await screen.findByText('Step 3 of 3 — Done');

    unmount();
    // Give any stray microtask a tick to fire before asserting it didn't.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockAbandon).not.toHaveBeenCalled();
  });

  it('does NOT abandon again on unmount after Cancel already abandoned it', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/import']}>
        <ImportWizardPage />
      </MemoryRouter>
    );
    const file = new File(['zipbytes'], 'dragon.zip', { type: 'application/zip' });
    fireEvent.change(document.getElementById('import-zip-input')!, { target: { files: [file] } });
    await screen.findByDisplayValue('Dragon Prints');

    fireEvent.click(screen.getByRole('button', { name: /Cancel import/ }));
    await waitFor(() => expect(mockAbandon).toHaveBeenCalledTimes(1));

    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockAbandon).toHaveBeenCalledTimes(1);
  });
});
