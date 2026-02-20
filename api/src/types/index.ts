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
  created_at: number;
}

export interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: number;
}

export interface ScanResult {
  imported: number;
  skipped: number;
  failed: number;
}
