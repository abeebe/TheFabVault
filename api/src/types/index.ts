// ─── Settings types ────────────────────────────────────────────────────────────

export interface PrinterSettings {
  material?: string;         // PLA, PETG, ABS, ASA, TPU, etc.
  nozzleDiameter?: number;   // mm
  nozzleTemp?: number;       // °C
  bedTemp?: number;          // °C
  layerHeight?: number;      // mm
  printSpeed?: number;       // mm/s
  infillPercent?: number;    // 0–100
  supports?: boolean;
  brimWidthMm?: number;      // mm
}

export interface LaserSettings {
  material?: string;
  materialThicknessMm?: number; // mm
  powerPercent?: number;        // 0–100
  speedMmMin?: number;          // mm/min
  passes?: number;
  kerfMm?: number;              // mm
  airAssist?: boolean;
}

export interface VinylSettings {
  material?: string;         // Adhesive Vinyl, HTV, etc.
  cuttingSpeed?: number;
  bladePressure?: number;    // grams
  bladeDepth?: number;       // mm
  passes?: number;
  mirrored?: boolean;        // for heat-transfer vinyl
}

export type ProjectOverrides = {
  printer?: Partial<PrinterSettings>;
  laser?: Partial<LaserSettings>;
  vinyl?: Partial<VinylSettings>;
};

// ─── Asset metadata ────────────────────────────────────────────────────────────

export interface AssetMeta {
  // Images
  width?: number;
  height?: number;
  colorSpace?: string;
  channels?: number;
  hasAlpha?: boolean;
  dpi?: number;

  // 3D models
  triangleCount?: number;
  boundingBox?: { x: number; y: number; z: number }; // mm

  // GCode
  slicer?: string;
  slicerVersion?: string;
  printTimeSeconds?: number;
  printTimeFormatted?: string;
  filamentUsedMm?: number;
  filamentUsedG?: number;
  layerCount?: number;
  layerHeight?: number;
  nozzleTemp?: number;
  bedTemp?: number;
  nozzleDiameter?: number;
  filamentType?: string;
  machineType?: string;

  // SVG
  svgWidth?: string;
  svgHeight?: string;
  svgViewBox?: string;

  // DXF
  dxfEntityCount?: number;
  dxfEntityTypes?: Record<string, number>;
  dxfBounds?: { width: number; height: number };
}

// ─── Output types (sent to client) ────────────────────────────────────────────

export interface AssetOut {
  id: string;
  filename: string;
  originalName: string | null;
  mime: string;
  size: number;
  folderId: string | null;
  tags: string[];
  notes: string | null;
  thumbStatus: 'none' | 'pending' | 'done' | 'failed';
  thumbUrl: string | null;
  url: string;
  meta: AssetMeta;
  createdAt: number;
  category: string | null;
  deletedAt: number | null;
  rating: number | null;
  isFavorite: boolean;
}

export interface VersionOut {
  id: string;
  assetId: string;
  versionNum: number;
  filename: string;
  size: number;
  fileHash: string | null;
  notes: string | null;
  createdAt: number;
}

export interface FolderOut {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface ProjectOut {
  id: string;
  name: string;
  description: string | null;
  folderId: string | null;
  tags: string[];
  printerSettings: PrinterSettings;
  laserSettings: LaserSettings;
  vinylSettings: VinylSettings;
  // assetCount is (and always has been) the count of project_assets rows.
  // Once a project grows a build manifest (hasManifest === true), this
  // number IS the "ungrouped" count — files not yet organized into a
  // sub-assembly — since organizing a file removes its project_assets row.
  // No separate ungrouped-count field needed; see services/manifestRollup.ts.
  assetCount: number;
  // Build manifest summary (migration v12). false/null when the project
  // has zero sub_assemblies rows — the flat, unmodified, "kept as-is"
  // path the original PRD guarantees. manifestPercent is null when a
  // manifest exists but zero parts have been placed anywhere yet ("no
  // parts placed yet" is a distinct fact from "0% of something real").
  hasManifest: boolean;
  manifestPercent: number | null;
  createdAt: number;
}

export interface ProjectAssetOut extends AssetOut {
  overrides: ProjectOverrides;
}

export interface ProjectDetailOut extends ProjectOut {
  assets: ProjectAssetOut[];
}

// ─── Build Manifest (sub-assemblies) — migration v12 ──────────────────────────
//
// Hierarchical breakdown of a project into named sub-assemblies (Right Foot,
// Dome, Dome Ring nested inside Dome...), each holding "part" placements of
// existing vault assets with a quantity + printed-count. See:
// Reports/sloane-prd-thefabvault-build-manifest-2026-07-06.md (data model)
// Reports/reid-thefabvault-manifest-ux-2026-07-06.md (UI/IA)

export interface SubAssemblyRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  created_at: number;
}

export interface SubAssemblyPartRow {
  sub_assembly_id: string;
  asset_id: string;
  quantity: number;
  printed_count: number;
  sort_order: number;
  overrides_json: string;
  created_at: number;
}

export interface SubAssemblyRollup {
  needed: number;
  done: number;
  // null when needed === 0 — "no parts placed yet" is a distinct fact
  // from "0% of something real" (PRD, progress rollup section).
  percent: number | null;
}

export interface SubAssemblyOut {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  sortOrder: number;
  createdAt: number;
  // Rolled up recursively across this node and all of its descendants.
  rollup: SubAssemblyRollup;
}

export interface SubAssemblyPartOut {
  subAssemblyId: string;
  quantity: number;
  printedCount: number;
  sortOrder: number;
  overrides: ProjectOverrides;
  asset: AssetOut;
}

// Whole-manifest payload for one project. Fetched once per project load
// (Reid's UX spec, section 7): Build Mode's breadcrumb drill-down is pure
// client-side state against this flat tree, never a per-node network call.
export interface ManifestOut {
  subAssemblies: SubAssemblyOut[];
  parts: SubAssemblyPartOut[];
  projectRollup: SubAssemblyRollup;
  ungroupedCount: number;
}

// ─── Sets (lightweight asset grouping) ────────────────────────────────────────

export interface SetOut {
  id: string;
  name: string;
  description: string | null;
  coverAssetId: string | null;
  // URL to the cover image (thumbnail of cover_asset_id, or null if
  // unset or that asset has no thumbnail).
  coverThumbUrl: string | null;
  assetCount: number;
  createdAt: number;
}

export interface SetDetailOut extends SetOut {
  assets: AssetOut[];
}

export interface SetSuggestion {
  // Suggested name derived from the shared filename stem.
  name: string;
  folderId: string | null;
  folderName: string | null;
  assetIds: string[];
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expiresIn: number;
}

export interface HealthResponse {
  ok: boolean;
  authRequired: boolean;
}

// ─── Users (Phase D, #2177 — routes/users.ts + GET /auth/me) ─────────────────
//
// AuthMeOut is the whole-app identity/role contract: every client-side
// gate (admin nav, ownership checks) reads from GET /auth/me, never from
// decoding the JWT (which only ever carries `sub` — see auth.ts's
// createToken comment). UserOut is the admin-facing shape (adds
// disabled/timestamps) used by the GET/POST/PATCH /users* admin CRUD —
// deliberately a superset of AuthMeOut's fields rather than an unrelated
// shape, so the two stay easy to reason about side by side.
export interface AuthMeOut {
  id: string;
  username: string;
  displayName: string | null;
  role: 'admin' | 'member';
}

export interface UserOut {
  id: string;
  username: string;
  displayName: string | null;
  role: 'admin' | 'member';
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── DB row types ─────────────────────────────────────────────────────────────

// Users (migration v13 — env-to-DB auth migration; migration v15 —
// #2154 table-copy dropped the v13 `role CHECK(role IN ('admin'))` and
// added display_name/disabled to prep for Phase D multi-user). role is
// validated at the app layer (services/enumValidators.ts: UserRole)
// instead of a SQL CHECK — see that module's header for why. The API
// surface is still single-admin as of this migration (no users-list
// UI, no invite flow, no RBAC yet — that's Phase D); this type only
// stops being a lie about what the column can hold.
export interface UserRow {
  id: string;
  username: string;
  password_hash: string; // 'scrypt:N:r:p:saltHex:hashHex' — see passwords.ts
  role: 'admin' | 'member';
  display_name: string | null;
  disabled: number; // 0 = active, 1 = disabled (SQLite has no boolean type)
  created_at: number;
  updated_at: number;
  // #2185, migration v17 — bumped on password reset to invalidate every
  // token minted before the bump (see auth.ts's requireAuth/requireAdmin
  // and createToken). Never exposed on UserOut/AuthMeOut — this is an
  // internal revocation counter, not part of the admin-facing user shape.
  token_version: number;
}

export interface AssetRow {
  id: string;
  filename: string;
  original_name: string | null;
  mime: string;
  size: number;
  folder_id: string | null;
  tags_json: string;
  notes: string | null;
  source_path: string | null;
  thumb_status: 'none' | 'pending' | 'done' | 'failed';
  meta_json: string;
  created_at: number;
  category: string | null;
  file_hash: string | null;
  deleted_at: number | null;
  rating: number | null;
  is_favorite: number;
  source_mtime_ms: number | null;
}

export interface VersionRow {
  id: string;
  asset_id: string;
  version_num: number;
  filename: string;
  size: number;
  file_hash: string | null;
  notes: string | null;
  created_at: number;
}

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  folder_id: string | null;
  tags_json: string;
  printer_settings_json: string;
  laser_settings_json: string;
  vinyl_settings_json: string;
  created_at: number;
}

export interface ProjectAssetRow {
  project_id: string;
  asset_id: string;
  sort_order: number;
  overrides_json: string;
}

export interface SetRow {
  id: string;
  name: string;
  description: string | null;
  cover_asset_id: string | null;
  created_at: number;
}

export interface SetAssetRow {
  set_id: string;
  asset_id: string;
  sort_order: number;
}

// SubAssemblyRow / SubAssemblyPartRow are declared above, alongside their
// *Out counterparts — see "Build Manifest (sub-assemblies)" section.

// ─── Models ("Local MakerWorld" restructure, migration v15, #2154/#2155) ──────
//
// See Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md.
// A model references existing assets via model_files (role: part/image/
// doc/other — services/enumValidators.ts) rather than owning file bytes
// itself; gallery images are just assets with role='image' riding the
// existing thumbnail pipeline. visibility/role columns are validated at
// the app layer (enumValidators.ts), never a SQL CHECK — see that
// module's header for why.

export interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: number;
}

export interface CategoryOut {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export interface ModelRow {
  id: string;
  title: string;
  description: string | null;
  category_id: string | null;
  tags_json: string;
  owner_id: string | null;
  visibility: 'public' | 'private';
  cover_asset_id: string | null;
  source_url: string | null;
  source_site: string | null;
  source_author: string | null;
  license: string | null;
  source_folder_id: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ModelFileRow {
  model_id: string;
  asset_id: string;
  role: 'part' | 'image' | 'doc' | 'other';
  sort_order: number;
  label: string | null;
}

export interface PrintProfileRow {
  id: string;
  model_id: string;
  name: string;
  printer: string | null;
  material: string | null;
  nozzle: string | null;
  layer_height: number | null;
  infill: number | null;
  supports: number; // 0/1 — SQLite has no boolean type
  notes: string | null;
  settings_json: string;
  sliced_asset_id: string | null;
  sort_order: number;
  created_at: number;
}

// One linked file inside a model's detail payload — the join row plus
// the full asset it points at (so the client never needs a second
// round-trip per file to render a gallery/parts list).
export interface ModelFileOut {
  assetId: string;
  role: 'part' | 'image' | 'doc' | 'other';
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
  visibility: 'public' | 'private';
  coverAssetId: string | null;
  // Resolved thumb URL for coverAssetId (or the first image-role file as
  // fallback), same pattern as SetOut.coverThumbUrl — null if nothing
  // usable yet.
  coverThumbUrl: string | null;
  sourceUrl: string | null;
  sourceSite: string | null;
  sourceAuthor: string | null;
  license: string | null;
  sourceFolderId: string | null;
  // Count of model_files rows joined to a non-deleted asset — mirrors
  // SetOut.assetCount's rationale (list view needs the count without a
  // second per-model request).
  fileCount: number;
  // Migration v16 (#2167). likeCount = COUNT(*) of model_likes rows for
  // this model; likedByMe = whether req.user has a row in model_likes
  // for this model (always false when there's no authenticated caller,
  // which in practice never happens — every route serving ModelOut sits
  // behind requireAuth).
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
//
// GET /models/from-folder/preview response shape — the same
// planFolderConversion() classification POST /models/from-folder acts on,
// but read-only: no models/model_files rows are written. Deliberately its
// own shape rather than a slice of ModelDetailOut — a preview has no
// model id yet (nothing has been created) and needs countsByRole +
// alreadyConverted, neither of which a real model has any use for.
export interface FolderConversionPreviewFile {
  assetId: string;
  filename: string;
  role: 'part' | 'image' | 'doc' | 'other';
  sortOrder: number;
}

export interface FolderConversionPreviewOut {
  folderId: string;
  folderName: string;
  // Same folder-name fallback POST /models/from-folder itself uses when
  // no title override is given — surfaced so the wizard can show/edit
  // the title it would submit, matching what would actually happen.
  suggestedTitle: string;
  assetCount: number;
  countsByRole: Record<'part' | 'image' | 'doc' | 'other', number>;
  files: FolderConversionPreviewFile[];
  coverAssetId: string | null;
  // True when a non-deleted model already has source_folder_id === this
  // folder. The wizard uses this to show an "already converted" marker
  // and require an explicit re-check before allowing a second convert of
  // the same folder (see routes/models.ts's batch idempotence guard).
  alreadyConverted: boolean;
  existingModelIds: string[];
}

// ─── Collections (Phase B, #2167) ─────────────────────────────────────────────
//
// Model-level analog of SetRow/SetAssetRow (v11) — same shape, except
// membership is models (collection_models) instead of assets
// (set_assets), and it carries owner_id/visibility like models does
// (migration v15). visibility reuses the models 'public'/'private' enum
// (enumValidators.ts's isModelVisibility) rather than a second copy —
// see db.ts's v16 migration comment.

export interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  owner_id: string | null;
  visibility: 'public' | 'private';
  cover_model_id: string | null;
  created_at: number;
}

export interface CollectionModelRow {
  collection_id: string;
  model_id: string;
  sort_order: number;
  added_at: number;
}

export interface ModelLikeRow {
  model_id: string;
  user_id: string;
  created_at: number;
}

export interface CollectionOut {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  visibility: 'public' | 'private';
  coverModelId: string | null;
  // Resolved cover thumb — coverModelId's own coverThumbUrl if it
  // resolves to one, else the first member model's coverThumbUrl, else
  // null. Same fallback shape as ModelOut.coverThumbUrl/SetOut's.
  coverThumbUrl: string | null;
  modelCount: number;
  createdAt: number;
}

export interface CollectionDetailOut extends CollectionOut {
  models: ModelOut[];
}
