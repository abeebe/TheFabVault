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
  assetCount: number;
  createdAt: number;
}

export interface ProjectAssetOut extends AssetOut {
  overrides: ProjectOverrides;
}

export interface ProjectDetailOut extends ProjectOut {
  assets: ProjectAssetOut[];
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

export interface ScanResult {
  imported: number;
  skipped: number;
  failed: number;
}
