import type {
  AssetOut, FolderOut, LoginResponse, HealthResponse,
  ProjectOut, ProjectDetailOut, ProjectOverrides,
  SetOut, SetDetailOut, SetSuggestion,
  PrinterSettings, LaserSettings, VinylSettings, AdminConfig,
  MountSlotStatus, MountConfig, DuplicatesReport, VersionOut,
  OrphansReport, ManifestOut, SubAssemblyOut, SubAssemblyPartOut,
  ImportPlacementResult,
} from '../types/index.js';

const API_BASE = (import.meta.env.VITE_API_URL as string) || '';

function getToken(): string | null {
  return localStorage.getItem('mv_token');
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(init?.body && !(init.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> ?? {}),
  };

  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (res.status === 401) {
    localStorage.removeItem('mv_token');
    window.dispatchEvent(new Event('mv:unauthorized'));
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface AssetListParams {
  q?: string;
  tags?: string;
  folder_id?: string;
  category?: '3dmodel' | '2d' | 'uncategorized';
  favorites?: boolean;
  limit?: number;
  offset?: number;
  sort?: string;
}

export interface PaginatedAssets {
  items: AssetOut[];
  total: number;
}

// ─── Models ("Local MakerWorld" restructure, #2154/#2155) ─────────────────────
//
// Types defined locally here (not in ../types/index.ts) — same convention
// as AssetListParams/PaginatedAssets just above: this file is the single
// cross-engineer contract for the new endpoints (api/src/routes/models.ts),
// committed first so Remy's A4 (ModelPage/LibraryPage) can build against
// it before the route implementation details are finalized. Mirrors the
// shape of api/src/types/index.ts's ModelOut/ModelDetailOut/etc. exactly —
// keep both in sync by hand if either changes.

export interface ModelListParams {
  q?: string;
  // Filters models.category_id (the curated categories tree) — NOT the
  // same concept as AssetListParams.category (a computed 3dmodel/2d/
  // uncategorized bucket inferred from filename). Same param name,
  // different underlying filter, because models actually have a real
  // category table assets don't.
  category?: string;
  tags?: string;
  owner?: 'me';
  // 'likes' added #2167 (migration v16) — orders by model_likes count
  // descending, ties broken by created_at descending (see
  // routes/models.ts's MODEL_SORT_MAP comment).
  sort?: 'date_desc' | 'date_asc' | 'name_asc' | 'name_desc' | 'likes';
  limit?: number;
  offset?: number;
}

export interface PaginatedModels {
  items: ModelOut[];
  total: number;
}

// ─── Categories (#2164, follow-up from Remy's A4 #2157 finding) ───────────────
//
// Types defined locally here rather than in ../types/index.ts, same
// convention as the Models section above (and AssetListParams/
// PaginatedAssets before that) -- this file is the single cross-engineer
// contract for the new endpoints (api/src/routes/categories.ts). Mirrors
// api/src/types/index.ts's CategoryRow/CategoryOut exactly -- keep both
// in sync by hand if either changes.
export interface CategoryOut {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export interface CategoryCreateBody {
  name: string;
  parentId?: string | null;
  sortOrder?: number;
}

export type CategoryUpdateBody = Partial<{
  name: string;
  parentId: string | null;
  sortOrder: number;
}>;

// ─── Users (Phase D, #2177) ────────────────────────────────────────────────
//
// Contract commit for api/src/routes/users.ts + GET /auth/me. Same
// "defined locally here, mirror api/src/types/index.ts by hand" convention
// as Categories/Models above. AuthMeOut/UserOut mirror the server types
// exactly; UserRole is the same 'admin' | 'member' enum
// services/enumValidators.ts (server) validates against.
export type UserRole = 'admin' | 'member';

export interface AuthMeOut {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
}

export interface UserOut {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// generatedPassword is present ONLY when the caller did not supply a
// password themselves (create with no `password`, or reset-password with
// no `password`) — see routes/users.ts's create/reset-password handlers.
// Shown to the admin exactly once; the API never returns it again after
// this response.
export interface UserCreateResponse extends UserOut {
  generatedPassword?: string;
}

export interface UserCreateBody {
  username: string;
  // Omit to have the server generate one (returned once as
  // generatedPassword on the response).
  password?: string;
  // Defaults to 'member' server-side if omitted.
  role?: UserRole;
  displayName?: string | null;
}

export type UserUpdateBody = Partial<{
  role: UserRole;
  displayName: string | null;
  disabled: boolean;
}>;

export interface UserResetPasswordBody {
  // Omit to have the server generate one.
  password?: string;
}

export type ModelFileRole = 'part' | 'image' | 'doc' | 'other';
export type ModelVisibility = 'public' | 'private';

export interface ModelFileOut {
  assetId: string;
  role: ModelFileRole;
  sortOrder: number;
  label: string | null;
  asset: AssetOut;
}

export interface PrintProfileOut {
  id: string;
  modelId: string;
  name: string;
  printer: string | null;
  material: string | null;
  nozzle: string | null;
  layerHeight: number | null;
  infill: number | null;
  supports: boolean;
  notes: string | null;
  settings: Record<string, unknown>;
  slicedAssetId: string | null;
  sortOrder: number;
  createdAt: number;
}

export interface ModelOut {
  id: string;
  title: string;
  description: string | null;
  categoryId: string | null;
  tags: string[];
  ownerId: string | null;
  visibility: ModelVisibility;
  coverAssetId: string | null;
  coverThumbUrl: string | null;
  sourceUrl: string | null;
  sourceSite: string | null;
  sourceAuthor: string | null;
  license: string | null;
  sourceFolderId: string | null;
  fileCount: number;
  // #2167 (migration v16): count of model_likes rows for this model,
  // and whether the requesting user has liked it.
  likeCount: number;
  likedByMe: boolean;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ModelDetailOut extends ModelOut {
  files: ModelFileOut[];
  profiles: PrintProfileOut[];
}

// ─── Folder→model conversion preview (Phase B, #2170) ─────────────────────────
// Mirrors api/src/types/index.ts's FolderConversionPreviewOut exactly —
// same cross-engineer-contract convention as the rest of this section.
export interface FolderConversionPreviewFile {
  assetId: string;
  filename: string;
  role: ModelFileRole;
  sortOrder: number;
}

export interface FolderConversionPreviewOut {
  folderId: string;
  folderName: string;
  suggestedTitle: string;
  assetCount: number;
  countsByRole: Record<ModelFileRole, number>;
  files: FolderConversionPreviewFile[];
  coverAssetId: string | null;
  alreadyConverted: boolean;
  existingModelIds: string[];
}

export interface ModelCreateBody {
  title: string;
  description?: string;
  categoryId?: string | null;
  tags?: string[];
  visibility?: ModelVisibility;
  sourceUrl?: string;
  sourceSite?: string;
  sourceAuthor?: string;
  license?: string;
}

export interface ModelUpdateBody {
  title?: string;
  description?: string | null;
  categoryId?: string | null;
  tags?: string[];
  visibility?: ModelVisibility;
  sourceUrl?: string | null;
  sourceSite?: string | null;
  sourceAuthor?: string | null;
  license?: string | null;
}

export interface PrintProfileCreateBody {
  name: string;
  printer?: string;
  material?: string;
  nozzle?: string;
  layerHeight?: number;
  infill?: number;
  supports?: boolean;
  notes?: string;
  settings?: Record<string, unknown>;
  slicedAssetId?: string | null;
}

export type PrintProfileUpdateBody = Partial<{
  name: string;
  printer: string | null;
  material: string | null;
  nozzle: string | null;
  layerHeight: number | null;
  infill: number | null;
  supports: boolean;
  notes: string | null;
  settings: Record<string, unknown>;
  slicedAssetId: string | null;
  sortOrder: number;
}>;

// ─── Collections (Phase B, #2167) ─────────────────────────────────────────────
//
// Same convention as Models/Categories above -- types defined locally
// here as the single cross-engineer contract for
// api/src/routes/collections.ts, mirroring
// api/src/types/index.ts's CollectionRow/CollectionOut/CollectionDetailOut
// exactly. Model-level analog of SetOut/SetDetailOut (v11), except
// membership is models, and it carries owner_id/visibility like ModelOut
// does.

export interface CollectionOut {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  visibility: ModelVisibility;
  coverModelId: string | null;
  coverThumbUrl: string | null;
  modelCount: number;
  createdAt: number;
}

export interface CollectionDetailOut extends CollectionOut {
  models: ModelOut[];
}

export interface CollectionCreateBody {
  name: string;
  description?: string;
  visibility?: ModelVisibility;
  modelIds?: string[];
}

export type CollectionUpdateBody = Partial<{
  name: string;
  description: string | null;
  visibility: ModelVisibility;
}>;

// ─── Zip Import (Phase C, #2171/#2172) ────────────────────────────────────────
//
// Same convention as Models/Categories/Collections above -- types defined
// locally here as the single cross-engineer contract for
// api/src/routes/modelImport.ts, mirroring
// api/src/services/zipImportClassify.ts's ZipImportPlan/ClassifiedZipFile
// and api/src/routes/modelImport.ts's request/response shapes exactly --
// keep both in sync by hand if either changes. Remy's C3 (ImportWizard)
// builds against this.

// 'ignore' is never a real model_files role (it's a classifier-only
// concept for macOS junk / bare directory-listing entries) -- kept as a
// distinct union member here, same as the API side, rather than folded
// into ModelFileRole, so a wizard row can render an "ignored" state
// without a type-level lie.
export type ZipEntryRole = ModelFileRole | 'ignore';

export interface ClassifiedZipFile {
  path: string;
  role: ZipEntryRole;
  // zip-slip flag -- the wizard should render these as excluded/disabled,
  // never selectable for commit. The server independently re-enforces
  // this at commit time regardless of what a client sends.
  invalid: boolean;
  invalidReason?: 'absolute path' | 'path traversal (..)' | 'empty path';
  // Passthrough of the original zip entry's declared size, when known --
  // lets the plan-review UI show per-file size without re-joining
  // against the upload's entry list by path (Remy's C1 review finding,
  // #2171 follow-up). Omitted, not 0, when the size was never provided.
  size?: number;
}

export type GuessedSourceSite = 'makerworld' | 'printables' | 'thingiverse' | null;

export interface ZipImportPlan {
  suggestedTitle: string;
  files: ClassifiedZipFile[];
  descriptionSource: string | null;
  profileCandidates: string[];
  guessedSourceSite: GuessedSourceSite;
  licenseFile: string | null;
}

export interface ZipImportDraftResponse {
  draftId: string;
  zipFilename: string;
  plan: ZipImportPlan;
  // Unix seconds -- convenience for a "this draft expires in ~2 days"
  // hint in the wizard; the server enforces the actual TTL independently
  // via its own sidecar-stored createdAt, this is just for display.
  expiresAt: number;
}

export interface ZipImportCommitFile {
  // Must match one of the draft plan's files[].path exactly (byte-for-
  // byte, whatever separator/case the archive used) -- the server looks
  // this up against its own stored copy of the original plan, not the
  // client's.
  path: string;
  // Defaults server-side to the original classified role if omitted --
  // only pass this to override (e.g. the wizard's per-file role
  // reassignment). Never send 'ignore' or an invalid entry's path here;
  // the server 400s the whole commit if either slips through.
  role?: ModelFileRole;
  label?: string | null;
}

export interface ZipImportCommitProfile {
  // Must be one of the paths also present in `files` below.
  path: string;
  name?: string;
}

export interface ZipImportCommitBody {
  title: string;
  description?: string | null;
  categoryId?: string | null;
  tags?: string[];
  visibility?: ModelVisibility;
  sourceUrl?: string | null;
  // Omit to keep the plan's guessedSourceSite; pass '' or a value to
  // override/clear it explicitly.
  sourceSite?: string | null;
  sourceAuthor?: string | null;
  license?: string | null;
  files: ZipImportCommitFile[];
  // Must be one of `files`' paths with role='image'.
  coverPath?: string | null;
  profiles?: ZipImportCommitProfile[];
}

// Per-file dedup outcome (Remy's C3-consumer finding, #2172 follow-up --
// the wizard is promised a dedup summary, not just a bare model). One
// entry per submitted `files[]` path, same order.
//   'created'          -- no matching content existed anywhere; a new
//                          asset was stored.
//   'linked-existing'  -- matched an asset that already existed in the
//                          vault BEFORE this commit; linked, not duplicated.
//   'merged-duplicate' -- matched another path submitted in THIS SAME
//                          commit (identical byte content); this path's
//                          own role/label never took effect -- the
//                          FIRST matching path (by submission order) is
//                          the one that "won" the model_files link
//                          (INSERT OR IGNORE keeps the first insert for
//                          a given model+asset pair). Surface this
//                          distinctly in the UI rather than letting it
//                          look identical to an ordinary link/create.
export interface ZipImportCommitFileResult {
  path: string;
  assetId: string;
  outcome: 'created' | 'linked-existing' | 'merged-duplicate';
}

export interface ZipImportCommitResult {
  model: ModelDetailOut;
  files: ZipImportCommitFileResult[];
}

export const api = {
  health: (): Promise<HealthResponse> => apiFetch('/health'),

  auth: {
    login: (username: string, password: string): Promise<LoginResponse> =>
      apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
    refresh: (): Promise<LoginResponse> =>
      apiFetch('/auth/refresh', { method: 'POST' }),

    // The whole-app identity/role contract (#2177) — every client-side
    // role gate (admin nav, ownership checks) reads from this, never from
    // decoding the JWT itself (the token only ever carries `sub`).
    me: (): Promise<AuthMeOut> => apiFetch('/auth/me'),
  },

  assets: {
    list: (params: AssetListParams = {}): Promise<PaginatedAssets> => {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      if (params.tags) qs.set('tags', params.tags);
      if (params.folder_id) qs.set('folder_id', params.folder_id);
      if (params.category) qs.set('category', params.category);
      if (params.favorites) qs.set('favorites', 'true');
      if (params.limit) qs.set('limit', String(params.limit));
      if (params.offset !== undefined) qs.set('offset', String(params.offset));
      if (params.sort) qs.set('sort', params.sort);
      const query = qs.toString();
      return apiFetch(`/assets${query ? `?${query}` : ''}`);
    },

    get: (id: string): Promise<AssetOut> => apiFetch(`/asset/${id}`),

    stats: (): Promise<{
      total: number;
      totalSize: number;
      favorites: number;
      threeDmodel: number;
      twoD: number;
      uncategorized: number;
    }> => apiFetch('/asset-stats'),

    upload: (
      file: File,
      opts: {
        folderId?: string;
        tags?: string[];
        notes?: string;
        // Called with bytes uploaded so far + total bytes. Triggers the
        // XHR path so the upload progress event can be observed; without
        // this callback the request uses fetch.
        onProgress?: (loaded: number, total: number) => void;
      } = {},
    ): Promise<AssetOut> => {
      const fd = new FormData();
      fd.append('file', file);
      if (opts.folderId) fd.append('folder_id', opts.folderId);
      if (opts.tags?.length) fd.append('tags', opts.tags.join(','));
      if (opts.notes) fd.append('notes', opts.notes);

      if (!opts.onProgress) {
        return apiFetch('/upload', { method: 'POST', body: fd });
      }

      // XHR path — fetch doesn't expose upload progress.
      return new Promise<AssetOut>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const token = getToken();
        xhr.open('POST', `${API_BASE}/upload`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress!(e.loaded, e.total);
        };
        xhr.onload = () => {
          if (xhr.status === 401) {
            localStorage.removeItem('mv_token');
            window.dispatchEvent(new Event('mv:unauthorized'));
            reject(new Error('Unauthorized'));
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText) as AssetOut); }
            catch (err) { reject(err); }
          } else {
            reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.onabort = () => reject(new Error('Upload aborted'));
        xhr.send(fd);
      });
    },

    uploadBatch: (files: File[], folderId?: string): Promise<AssetOut[]> => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      if (folderId) fd.append('folder_id', folderId);
      return apiFetch('/upload/batch', { method: 'POST', body: fd });
    },

    updateMeta: (id: string, body: { title?: string; notes?: string }): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/meta`, { method: 'PATCH', body: JSON.stringify(body) }),

    updateTags: (id: string, tags: string[]): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/tags`, { method: 'PATCH', body: JSON.stringify({ tags }) }),

    rename: (id: string, filename: string): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/rename`, { method: 'PATCH', body: JSON.stringify({ filename }) }),

    moveToFolder: (id: string, folderId: string | null): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder_id: folderId }) }),

    // Soft-delete (moves to trash). Use trash.empty() or trash.deletePermanently() for hard delete.
    delete: (id: string): Promise<void> =>
      apiFetch(`/asset/${id}`, { method: 'DELETE' }),

    deletePermanently: (id: string): Promise<void> =>
      apiFetch(`/asset/${id}?permanent=true`, { method: 'DELETE' }),

    extractMeta: (id: string): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/extract-meta`, { method: 'POST' }),

    setCategory: (id: string, category: string | null): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/category`, {
        method: 'PATCH',
        body: JSON.stringify({ category }),
      }),

    rethumb: (id: string): Promise<{ ok: boolean; queued: string }> =>
      apiFetch(`/asset/${id}/rethumb`, { method: 'POST' }),

    rethumbFailed: (): Promise<{ ok: boolean; queued: number }> =>
      apiFetch('/assets/rethumb-failed', { method: 'POST' }),

    checkHash: (hash: string): Promise<{ exists: boolean; asset?: AssetOut }> =>
      apiFetch('/check-hash', { method: 'POST', body: JSON.stringify({ hash }) }),

    setRating: (id: string, rating: number | null): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/rating`, { method: 'PATCH', body: JSON.stringify({ rating }) }),

    setFavorite: (id: string, favorite: boolean): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/favorite`, { method: 'PATCH', body: JSON.stringify({ favorite }) }),

    getVersions: (id: string): Promise<{ versions: VersionOut[] }> =>
      apiFetch(`/asset/${id}/versions`),

    uploadVersion: (id: string, file: File, notes?: string): Promise<{ asset: AssetOut }> => {
      const fd = new FormData();
      fd.append('file', file);
      if (notes) fd.append('notes', notes);
      return apiFetch(`/asset/${id}/version`, { method: 'POST', body: fd });
    },

    restoreVersion: (id: string, versionId: string): Promise<{ asset: AssetOut }> =>
      apiFetch(`/asset/${id}/version/${versionId}/restore`, { method: 'POST' }),

    deleteVersion: (id: string, versionId: string): Promise<{ ok: boolean }> =>
      apiFetch(`/asset/${id}/version/${versionId}`, { method: 'DELETE' }),

    fileUrl: (asset: AssetOut): string => {
      const token = getToken();
      const base = `${API_BASE}${asset.url}`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    },

    thumbUrl: (asset: AssetOut): string | null => {
      if (!asset.thumbUrl) return null;
      const token = getToken();
      const base = `${API_BASE}${asset.thumbUrl}`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    },
  },

  models: {
    list: (params: ModelListParams = {}): Promise<PaginatedModels> => {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      if (params.category) qs.set('category', params.category);
      if (params.tags) qs.set('tags', params.tags);
      if (params.owner) qs.set('owner', params.owner);
      if (params.sort) qs.set('sort', params.sort);
      if (params.limit) qs.set('limit', String(params.limit));
      if (params.offset !== undefined) qs.set('offset', String(params.offset));
      const query = qs.toString();
      return apiFetch(`/models${query ? `?${query}` : ''}`);
    },

    get: (id: string): Promise<ModelDetailOut> => apiFetch(`/model/${id}`),

    create: (body: ModelCreateBody): Promise<ModelOut> =>
      apiFetch('/models', { method: 'POST', body: JSON.stringify(body) }),

    update: (id: string, body: ModelUpdateBody): Promise<ModelOut> =>
      apiFetch(`/model/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

    // Soft-delete (hides only) by default. permanent: true removes the
    // model + its model_files/print_profiles rows — never asset rows.
    delete: (id: string, opts: { permanent?: boolean } = {}): Promise<void> =>
      apiFetch(`/model/${id}${opts.permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),

    // Explicit folder→model conversion — never silent/automatic. The
    // folder and its assets are untouched; this only creates a new model
    // + model_files links.
    fromFolder: (folderId: string, title?: string): Promise<ModelDetailOut> =>
      apiFetch('/models/from-folder', { method: 'POST', body: JSON.stringify({ folderId, title }) }),

    // Dry-run counterpart of fromFolder above — same classification,
    // zero writes (see routes/models.ts's preview handler comment). The
    // bulk convert wizard calls this once per folder before the user
    // confirms anything.
    previewFromFolder: (folderId: string): Promise<FolderConversionPreviewOut> =>
      apiFetch(`/models/from-folder/preview?folder_id=${encodeURIComponent(folderId)}`),

    // Link assets already in the vault onto a model.
    attachExisting: (
      id: string,
      assetIds: string[],
      role?: ModelFileRole,
    ): Promise<{ attached: number; model: ModelDetailOut }> =>
      apiFetch(`/model/${id}/files`, { method: 'POST', body: JSON.stringify({ assetIds, role }) }),

    // Upload new files directly onto a model. Server dedups by content
    // hash (findAssetByHash) — a byte-identical file already in the
    // vault gets linked, not re-stored as a second copy.
    uploadFiles: (
      id: string,
      files: File[],
      role?: ModelFileRole,
    ): Promise<{ attached: number; model: ModelDetailOut }> => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      if (role) fd.append('role', role);
      return apiFetch(`/model/${id}/files`, { method: 'POST', body: fd });
    },

    detachFile: (id: string, assetId: string): Promise<void> =>
      apiFetch(`/model/${id}/file/${assetId}`, { method: 'DELETE' }),

    // assetIds is the full desired order; sort_order is assigned as each
    // id's array index.
    reorderFiles: (id: string, assetIds: string[]): Promise<ModelDetailOut> =>
      apiFetch(`/model/${id}/files/reorder`, { method: 'PATCH', body: JSON.stringify({ assetIds }) }),

    // assetId must already be attached to the model; null clears the
    // cover (falls back to the first image-role file, server-side).
    setCover: (id: string, assetId: string | null): Promise<ModelDetailOut> =>
      apiFetch(`/model/${id}/cover`, { method: 'PATCH', body: JSON.stringify({ assetId }) }),

    downloadUrl: (id: string): string => {
      const token = getToken();
      const base = `${API_BASE}/model/${id}/download`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    },

    // Additive convenience (A4, #2157) -- ModelOut.coverThumbUrl is a raw
    // path (same shape as AssetOut.thumbUrl), needing the exact same
    // auth-token query-param treatment as assets.thumbUrl above. Kept as
    // a thin wrapper here rather than duplicated in ModelCard/ModelPage.
    coverThumbUrl: (model: ModelOut): string | null => {
      if (!model.coverThumbUrl) return null;
      const token = getToken();
      const base = `${API_BASE}${model.coverThumbUrl}`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    },

    profiles: {
      list: (modelId: string): Promise<PrintProfileOut[]> => apiFetch(`/model/${modelId}/profiles`),

      create: (modelId: string, body: PrintProfileCreateBody): Promise<PrintProfileOut> =>
        apiFetch(`/model/${modelId}/profiles`, { method: 'POST', body: JSON.stringify(body) }),

      update: (profileId: string, body: PrintProfileUpdateBody): Promise<PrintProfileOut> =>
        apiFetch(`/profile/${profileId}`, { method: 'PATCH', body: JSON.stringify(body) }),

      delete: (profileId: string): Promise<void> =>
        apiFetch(`/profile/${profileId}`, { method: 'DELETE' }),
    },

    // Idempotent like/unlike (#2167) -- PUT/DELETE the same state
    // repeatedly is safe (model_likes PK makes it a no-op server-side).
    // Returns just the count + this user's state, not the full model --
    // a like button doesn't need a whole model/detail re-fetch.
    like: (id: string): Promise<{ likeCount: number; likedByMe: boolean }> =>
      apiFetch(`/model/${id}/like`, { method: 'PUT' }),

    unlike: (id: string): Promise<{ likeCount: number; likedByMe: boolean }> =>
      apiFetch(`/model/${id}/like`, { method: 'DELETE' }),
  },

  // GET is requireAuth (every user needs the list for a category
  // picker); create/update/delete are requireAdmin server-side -- this
  // client doesn't gate that itself, the API 401/403s a non-admin call.
  categories: {
    list: (): Promise<CategoryOut[]> => apiFetch('/categories'),

    create: (body: CategoryCreateBody): Promise<CategoryOut> =>
      apiFetch('/categories', { method: 'POST', body: JSON.stringify(body) }),

    update: (id: string, body: CategoryUpdateBody): Promise<CategoryOut> =>
      apiFetch(`/category/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

    delete: (id: string): Promise<void> =>
      apiFetch(`/category/${id}`, { method: 'DELETE' }),
  },

  // Model-level analog of `sets` below -- CRUD + membership + reorder +
  // cover, same shape, different member type (models, not assets).
  collections: {
    list: (): Promise<CollectionOut[]> => apiFetch('/collections'),

    get: (id: string): Promise<CollectionDetailOut> => apiFetch(`/collection/${id}`),

    create: (body: CollectionCreateBody): Promise<CollectionOut> =>
      apiFetch('/collections', { method: 'POST', body: JSON.stringify(body) }),

    update: (id: string, body: CollectionUpdateBody): Promise<CollectionOut> =>
      apiFetch(`/collection/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

    delete: (id: string): Promise<void> =>
      apiFetch(`/collection/${id}`, { method: 'DELETE' }),

    addModels: (id: string, modelIds: string[]): Promise<{ added: number }> =>
      apiFetch(`/collection/${id}/models`, { method: 'POST', body: JSON.stringify({ modelIds }) }),

    removeModel: (id: string, modelId: string): Promise<void> =>
      apiFetch(`/collection/${id}/model/${modelId}`, { method: 'DELETE' }),

    // modelIds is the full desired order; sort_order is assigned as each
    // id's array index -- same contract as models.reorderFiles.
    reorderModels: (id: string, modelIds: string[]): Promise<CollectionDetailOut> =>
      apiFetch(`/collection/${id}/models/reorder`, { method: 'PATCH', body: JSON.stringify({ modelIds }) }),

    // modelId must already be a member; null clears the cover (falls
    // back server-side to the first member model with a usable thumb).
    setCover: (id: string, modelId: string | null): Promise<CollectionOut> =>
      apiFetch(`/collection/${id}/cover`, { method: 'PATCH', body: JSON.stringify({ modelId }) }),

    // Additive convenience (B3, #2169) -- same token-appending treatment
    // as models.coverThumbUrl above; CollectionOut.coverThumbUrl is a raw
    // path (same shape as AssetOut.thumbUrl/ModelOut.coverThumbUrl) that
    // needs the auth-token query param to actually load.
    coverThumbUrl: (collection: CollectionOut): string | null => {
      if (!collection.coverThumbUrl) return null;
      const token = getToken();
      const base = `${API_BASE}${collection.coverThumbUrl}`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    },
  },

  // Zip import — draft/commit (Phase C, #2171/#2172). uploadZip creates a
  // draft (extracted server-side to scratch, never touching the vault
  // until commit); commit finalizes an edited plan into a real model;
  // abandon deletes the draft outright. No polling/list endpoint here —
  // a draft is a single-flight wizard session the client already knows
  // the id of, not a browsable resource.
  import: {
    // onProgress mirrors assets.upload's XHR path exactly (Remy's
    // C3-consumer finding, #2172 follow-up) -- a zip can be up to
    // MAX_ZIP_UPLOAD_BYTES (1 GiB server-side), so the wizard needs the
    // same upload-progress affordance a single large asset upload
    // already gets; fetch has no upload-progress event at all, which is
    // the whole reason assets.upload has this same fork.
    uploadZip: (
      file: File,
      opts: { onProgress?: (loaded: number, total: number) => void } = {},
    ): Promise<ZipImportDraftResponse> => {
      const fd = new FormData();
      fd.append('file', file);

      if (!opts.onProgress) {
        return apiFetch('/import/zip', { method: 'POST', body: fd });
      }

      return new Promise<ZipImportDraftResponse>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const token = getToken();
        xhr.open('POST', `${API_BASE}/import/zip`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress!(e.loaded, e.total);
        };
        xhr.onload = () => {
          if (xhr.status === 401) {
            localStorage.removeItem('mv_token');
            window.dispatchEvent(new Event('mv:unauthorized'));
            reject(new Error('Unauthorized'));
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText) as ZipImportDraftResponse); }
            catch (err) { reject(err); }
          } else {
            reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.onabort = () => reject(new Error('Upload aborted'));
        xhr.send(fd);
      });
    },

    commit: (draftId: string, body: ZipImportCommitBody): Promise<ZipImportCommitResult> =>
      apiFetch(`/import/zip/${draftId}/commit`, { method: 'POST', body: JSON.stringify(body) }),

    abandon: (draftId: string): Promise<void> =>
      apiFetch(`/import/zip/${draftId}`, { method: 'DELETE' }),
  },

  folders: {
    list: (): Promise<FolderOut[]> => apiFetch('/folders'),

    create: (name: string, parentId?: string): Promise<FolderOut> =>
      apiFetch('/folders', {
        method: 'POST',
        body: JSON.stringify({ name, parent_id: parentId }),
      }),

    update: (id: string, body: { name?: string; parentId?: string | null }): Promise<FolderOut> =>
      apiFetch(`/folder/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: body.name, parent_id: body.parentId }),
      }),

    delete: (id: string): Promise<void> =>
      apiFetch(`/folder/${id}`, { method: 'DELETE' }),

    downloadUrl: (id: string): string => {
      const token = getToken();
      const base = `${API_BASE}/folder/${id}/download`;
      return token ? `${base}?token=${encodeURIComponent(token)}` : base;
    },
  },

  projects: {
    list: (): Promise<ProjectOut[]> => apiFetch('/projects'),

    get: (id: string): Promise<ProjectDetailOut> => apiFetch(`/project/${id}`),

    create: (body: {
      name: string;
      description?: string;
      folderId?: string | null;
      tags?: string[];
      printerSettings?: PrinterSettings;
      laserSettings?: LaserSettings;
      vinylSettings?: VinylSettings;
    }): Promise<ProjectOut> =>
      apiFetch('/projects', { method: 'POST', body: JSON.stringify(body) }),

    update: (id: string, body: {
      name?: string;
      description?: string;
      folderId?: string | null;
      tags?: string[];
      printerSettings?: PrinterSettings;
      laserSettings?: LaserSettings;
      vinylSettings?: VinylSettings;
    }): Promise<ProjectOut> =>
      apiFetch(`/project/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

    delete: (id: string): Promise<void> =>
      apiFetch(`/project/${id}`, { method: 'DELETE' }),

    addAssets: (id: string, assetIds: string[]): Promise<void> =>
      apiFetch(`/project/${id}/assets`, { method: 'POST', body: JSON.stringify({ assetIds }) }),

    removeAsset: (id: string, assetId: string): Promise<void> =>
      apiFetch(`/project/${id}/asset/${assetId}`, { method: 'DELETE' }),

    updateOverrides: (id: string, assetId: string, overrides: ProjectOverrides): Promise<void> =>
      apiFetch(`/project/${id}/asset/${assetId}/overrides`, { method: 'PATCH', body: JSON.stringify(overrides) }),
  },

  // Build manifest (sub-assemblies) — Bet 1. Fetch the whole tree once per
  // project load; Build Mode's drill-down is pure client-side state against
  // it, never a per-node request.
  manifest: {
    get: (projectId: string): Promise<ManifestOut> => apiFetch(`/project/${projectId}/manifest`),

    createSubAssembly: (projectId: string, body: { name: string; parentId?: string }): Promise<SubAssemblyOut> =>
      apiFetch(`/project/${projectId}/sub-assemblies`, { method: 'POST', body: JSON.stringify(body) }),

    updateSubAssembly: (id: string, body: { name?: string; parentId?: string | null; sortOrder?: number }): Promise<SubAssemblyOut> =>
      apiFetch(`/sub-assembly/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

    deleteSubAssembly: (id: string): Promise<void> =>
      apiFetch(`/sub-assembly/${id}`, { method: 'DELETE' }),

    addParts: (subAssemblyId: string, assetIds: string[]): Promise<{ added: number }> =>
      apiFetch(`/sub-assembly/${subAssemblyId}/parts`, { method: 'POST', body: JSON.stringify({ assetIds }) }),

    updatePart: (subAssemblyId: string, assetId: string, body: { quantity?: number; printedCount?: number }): Promise<SubAssemblyPartOut> =>
      apiFetch(`/sub-assembly/${subAssemblyId}/part/${assetId}`, { method: 'PATCH', body: JSON.stringify(body) }),

    updatePartOverrides: (subAssemblyId: string, assetId: string, overrides: ProjectOverrides): Promise<void> =>
      apiFetch(`/sub-assembly/${subAssemblyId}/part/${assetId}/overrides`, { method: 'PATCH', body: JSON.stringify(overrides) }),

    removePart: (subAssemblyId: string, assetId: string): Promise<void> =>
      apiFetch(`/sub-assembly/${subAssemblyId}/part/${assetId}`, { method: 'DELETE' }),

    // Folder-tree import (Bet 2) — routes/manifestImport.ts. One call per
    // file, matching the existing upload worker-pool's per-file shape so
    // Commit-phase progress is observable file-by-file (Reid's UX spec,
    // section 7), not one opaque batch call.
    importUploadFile: (
      projectId: string,
      file: File,
      opts: {
        pathSegments: string[];
        parentSubAssemblyId: string | null;
        onProgress?: (loaded: number, total: number) => void;
      },
    ): Promise<ImportPlacementResult> => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('pathSegments', JSON.stringify(opts.pathSegments));
      if (opts.parentSubAssemblyId) fd.append('parentSubAssemblyId', opts.parentSubAssemblyId);

      if (!opts.onProgress) {
        return apiFetch(`/project/${projectId}/import/upload-file`, { method: 'POST', body: fd });
      }

      // XHR path for upload progress — same pattern as assets.upload above.
      return new Promise<ImportPlacementResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const token = getToken();
        xhr.open('POST', `${API_BASE}/project/${projectId}/import/upload-file`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress!(e.loaded, e.total);
        };
        xhr.onload = () => {
          if (xhr.status === 401) {
            localStorage.removeItem('mv_token');
            window.dispatchEvent(new Event('mv:unauthorized'));
            reject(new Error('Unauthorized'));
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText) as ImportPlacementResult); }
            catch (err) { reject(err); }
          } else {
            reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.onabort = () => reject(new Error('Upload aborted'));
        xhr.send(fd);
      });
    },

    importLinkExisting: (
      projectId: string,
      body: { assetId: string; pathSegments: string[]; parentSubAssemblyId: string | null },
    ): Promise<ImportPlacementResult> =>
      apiFetch(`/project/${projectId}/import/link-existing`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  sets: {
    list: (): Promise<SetOut[]> => apiFetch('/sets'),
    get: (id: string): Promise<SetDetailOut> => apiFetch(`/set/${id}`),
    create: (body: { name: string; description?: string; assetIds?: string[] }): Promise<SetOut> =>
      apiFetch('/sets', { method: 'POST', body: JSON.stringify(body) }),
    update: (id: string, body: { name?: string; description?: string | null; coverAssetId?: string | null }): Promise<SetOut> =>
      apiFetch(`/set/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    delete: (id: string): Promise<void> =>
      apiFetch(`/set/${id}`, { method: 'DELETE' }),
    addAssets: (id: string, assetIds: string[]): Promise<{ added: number }> =>
      apiFetch(`/set/${id}/assets`, { method: 'POST', body: JSON.stringify({ assetIds }) }),
    removeAsset: (id: string, assetId: string): Promise<void> =>
      apiFetch(`/set/${id}/asset/${assetId}`, { method: 'DELETE' }),
    suggest: (): Promise<{ suggestions: SetSuggestion[] }> => apiFetch('/sets/suggest'),
  },

  download: {
    zip: (opts: { assetIds?: string[]; folderId?: string; tag?: string; filename?: string }): Promise<Response> => {
      const token = getToken();
      return fetch(`${API_BASE}/download/zip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          asset_ids: opts.assetIds,
          folder_id: opts.folderId,
          tag: opts.tag,
          filename: opts.filename,
        }),
      });
    },
  },

  trash: {
    list: (): Promise<{ items: AssetOut[]; total: number }> =>
      apiFetch('/trash'),

    restore: (id: string): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/restore`, { method: 'POST' }),

    empty: (): Promise<{ ok: boolean; deleted: number }> =>
      apiFetch('/trash', { method: 'DELETE' }),
  },

  mounts: {
    list: (): Promise<MountSlotStatus[]> =>
      apiFetch('/admin/mounts'),

    save: (body: {
      slot: 1 | 2 | 3;
      name: string;
      type: 'nfs' | 'smb';
      host: string;
      remote_path: string;
      username?: string;
      password?: string;
      mount_opts?: string;
      enabled?: boolean;
      role?: 'import' | 'library';
    }): Promise<{ success: boolean; id: string }> =>
      apiFetch('/admin/mounts', { method: 'POST', body: JSON.stringify(body) }),

    delete: (slot: 1 | 2 | 3): Promise<{ success: boolean }> =>
      apiFetch(`/admin/mounts/${slot}`, { method: 'DELETE' }),

    mount: (slot: 1 | 2 | 3): Promise<{ success: boolean; mounted: boolean; message?: string }> =>
      apiFetch(`/admin/mounts/${slot}/mount`, { method: 'POST' }),

    unmount: (slot: 1 | 2 | 3): Promise<{ success: boolean; mounted: boolean; message?: string }> =>
      apiFetch(`/admin/mounts/${slot}/unmount`, { method: 'POST' }),
  },

  admin: {
    getConfig: (): Promise<AdminConfig> => apiFetch('/admin/config'),

    updateStoragePath: (newPath: string): Promise<{ success: boolean; message: string }> =>
      apiFetch('/admin/config/storage', {
        method: 'POST',
        body: JSON.stringify({ newPath }),
      }),

    restart: (): Promise<{ success: boolean; message: string }> =>
      apiFetch('/admin/restart', { method: 'POST' }),

    getDuplicates: (): Promise<DuplicatesReport> =>
      apiFetch('/admin/duplicates'),

    rehashFiles: (): Promise<{ ok: boolean; queued: number }> =>
      apiFetch('/admin/duplicates/rehash', { method: 'POST' }),

    getOrphans: (): Promise<OrphansReport> =>
      apiFetch('/admin/orphans'),

    cleanOrphans: (opts?: { deleteDeadRecords?: boolean; deleteOrphanDirs?: boolean }): Promise<{ ok: boolean; removedRecords: number; removedDirs: number }> =>
      apiFetch('/admin/orphans/clean', { method: 'POST', body: JSON.stringify(opts ?? {}) }),
  },

  // Admin users CRUD (Phase D, #2177) — all requireAdmin server-side, same
  // "this client doesn't gate that itself, the API 401/403s" split as
  // categories above. No delete() — disable via update() instead
  // (routes/users.ts's file header explains why: preserves
  // models.owner_id integrity, no silent orphaning).
  users: {
    list: (): Promise<UserOut[]> => apiFetch('/users'),

    create: (body: UserCreateBody): Promise<UserCreateResponse> =>
      apiFetch('/users', { method: 'POST', body: JSON.stringify(body) }),

    update: (id: string, body: UserUpdateBody): Promise<UserOut> =>
      apiFetch(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

    resetPassword: (id: string, body: UserResetPasswordBody = {}): Promise<UserCreateResponse> =>
      apiFetch(`/users/${id}/reset-password`, { method: 'POST', body: JSON.stringify(body) }),
  },
};
