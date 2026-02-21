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
  assetCount: number;
  createdAt: number;
}

export interface ProjectAssetOut extends AssetOut {
  overrides: ProjectOverrides;
}

export interface ProjectDetailOut extends ProjectOut {
  assets: ProjectAssetOut[];
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

export interface ScanResult {
  imported: number;
  skipped: number;
  failed: number;
}

// ─── Admin ────────────────────────────────────────────────────────────────────

export interface StorageStats {
  total: number;
  totalFormatted: string;
  assets: number;
  assetsFormatted: string;
  thumbnails: number;
  thumbnailsFormatted: string;
  assetCount: number;
}

export interface AdminConfig {
  storagePath: string;
  storagePathDisplay: string;
  dataDirPath: string;
  storage: StorageStats;
  config: {
    maxUploadMb: number;
    authEnabled: boolean;
    corsOrigins: string[];
  };
}

export type Theme = 'light' | 'dark' | 'system';
