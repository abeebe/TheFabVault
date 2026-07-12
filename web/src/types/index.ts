// ─── Settings ─────────────────────────────────────────────────────────────────

export interface PrinterSettings {
  material?: string;
  nozzleDiameter?: number;
  nozzleTemp?: number;
  bedTemp?: number;
  layerHeight?: number;
  printSpeed?: number;
  infillPercent?: number;
  supports?: boolean;
  brimWidthMm?: number;
}

export interface LaserSettings {
  material?: string;
  materialThicknessMm?: number;
  powerPercent?: number;
  speedMmMin?: number;
  passes?: number;
  kerfMm?: number;
  airAssist?: boolean;
}

export interface VinylSettings {
  material?: string;
  cuttingSpeed?: number;
  bladePressure?: number;
  bladeDepth?: number;
  passes?: number;
  mirrored?: boolean;
}

export type ProjectOverrides = {
  printer?: Partial<PrinterSettings>;
  laser?: Partial<LaserSettings>;
  vinyl?: Partial<VinylSettings>;
};

// ─── Asset metadata ───────────────────────────────────────────────────────────

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
  boundingBox?: { x: number; y: number; z: number };
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
}

// ─── Asset & Folder ───────────────────────────────────────────────────────────

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

// ─── Projects ─────────────────────────────────────────────────────────────────

export interface ProjectOut {
  id: string;
  name: string;
  description: string | null;
  folderId: string | null;
  tags: string[];
  printerSettings: PrinterSettings;
  laserSettings: LaserSettings;
  vinylSettings: VinylSettings;
  // Count of project_assets rows. Once hasManifest is true, this IS the
  // "ungrouped" count — files not yet organized into the build manifest.
  assetCount: number;
  // Build manifest summary (migration v12). hasManifest is false when the
  // project has no sub-assemblies yet — the flat AssetGrid view is shown
  // unchanged in that case. manifestPercent is null either when there's no
  // manifest, or when a manifest exists but zero parts have been placed
  // anywhere yet ("no parts placed yet" is distinct from "0% printed").
  hasManifest: boolean;
  manifestPercent: number | null;
  createdAt: number;
}

// Sets — lightweight asset grouping (no settings, no overrides).
export interface SetOut {
  id: string;
  name: string;
  description: string | null;
  coverAssetId: string | null;
  coverThumbUrl: string | null;
  assetCount: number;
  createdAt: number;
}

export interface SetDetailOut extends SetOut {
  assets: AssetOut[];
}

export interface SetSuggestion {
  name: string;
  folderId: string | null;
  folderName: string | null;
  assetIds: string[];
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
// existing vault assets with a quantity + printed-count.

export interface SubAssemblyRollup {
  needed: number;
  done: number;
  // null when needed === 0 — "no parts placed yet" is a distinct fact from
  // "0% of something real".
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

// Whole-manifest payload for one project. Fetched once per project load —
// Build Mode's breadcrumb drill-down is pure client-side state against this
// flat tree, never a per-node network call.
export interface ManifestOut {
  subAssemblies: SubAssemblyOut[];
  parts: SubAssemblyPartOut[];
  projectRollup: SubAssemblyRollup;
  ungroupedCount: number;
}

// ─── Folder-tree import (Bet 2) ────────────────────────────────────────────────
// Response shape shared by both POST /project/:id/import/upload-file and
// POST /project/:id/import/link-existing (routes/manifestImport.ts).

export interface ImportPlacementResult {
  asset: AssetOut;
  // false only for a genuinely-new file (upload-file, no hash match).
  // link-existing always returns true.
  linked: boolean;
  subAssemblyId: string | null;
  // Ids of any sub-assembly nodes newly created while resolving this
  // file's path — empty when every level already existed. Lets the Commit
  // UI show a live "N of M sub-assemblies created" count without guessing.
  createdSubAssemblyIds: string[];
}

// ─── Misc ─────────────────────────────────────────────────────────────────────

export interface LoginResponse {
  token: string;
  expiresIn: number;
}

export interface HealthResponse {
  ok: boolean;
  authRequired: boolean;
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface StorageStats {
  total: number;
  totalFormatted: string;
  assets: number;
  assetsFormatted: string;
  thumbnails: number;
  thumbnailsFormatted: string;
  versions: number;
  versionsFormatted: string;
  assetCount: number;
}

export interface AdminConfig {
  storagePath: string;
  storagePathDisplay: string;
  dataDirPath: string;
  storage: StorageStats;
  config: {
    authEnabled: boolean;
    corsOrigins: string[];
  };
}

export type Theme = 'light' | 'dark' | 'system';

// ─── Duplicates ───────────────────────────────────────────────────────────────

export interface DuplicateAsset {
  id: string;
  filename: string;
  originalName: string | null;
  size: number;
  createdAt: number;
  folderId: string | null;
  tags: string[];
  thumbUrl: string | null;
}

export interface DuplicateGroup {
  key: string;
  count: number;
  assets: DuplicateAsset[];
}

export interface DuplicatesReport {
  byName: DuplicateGroup[];
  byHash: DuplicateGroup[];
  unhashedCount: number;
}

// ─── Network Mounts ───────────────────────────────────────────────────────────

export interface MountConfig {
  id: string;
  slot: 1 | 2 | 3;
  name: string;
  type: 'nfs' | 'smb';
  host: string;
  remote_path: string;
  username: string | null;
  // The real password is never sent to the client (redacted server-side —
  // see api/src/routes/mounts.ts GET /admin/mounts). hasPassword tells the
  // UI whether a password is currently stored, without exposing it.
  hasPassword: boolean;
  mount_opts: string | null;
  enabled: number;
  role: 'import' | 'library';
  created_at: number;
  updated_at: number;
}

export interface MountSlotStatus {
  slot: 1 | 2 | 3;
  mountPoint: string;
  mounted: boolean;
  config: MountConfig | null;
}

// ─── Orphans ──────────────────────────────────────────────────────────────────

export interface OrphanRecord {
  id: string;
  filename: string;
}

export interface OrphansReport {
  deadRecords: OrphanRecord[];
  orphanDirs: string[];
}
