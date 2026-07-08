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

// ─── DB row types ─────────────────────────────────────────────────────────────

// Admin users (migration v13 — env-to-DB auth migration). Single role
// today ('admin'); the CHECK constraint exists so a future multi-user
// pass doesn't need a breaking migration, but the API surface is
// single-admin for now (no users-list UI, no invite flow, no RBAC).
export interface UserRow {
  id: string;
  username: string;
  password_hash: string; // 'scrypt:N:r:p:saltHex:hashHex' — see passwords.ts
  role: 'admin';
  created_at: number;
  updated_at: number;
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

export interface ScanResult {
  imported: number;
  skipped: number;
  failed: number;
}
