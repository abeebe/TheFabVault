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
  createdAt: number;
}

export interface FolderOut {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

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

export type Theme = 'light' | 'dark' | 'system';
