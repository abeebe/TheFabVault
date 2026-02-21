import type {
  AssetOut, FolderOut, LoginResponse, HealthResponse, ScanResult,
  ProjectOut, ProjectDetailOut, ProjectOverrides,
  PrinterSettings, LaserSettings, VinylSettings, AdminConfig,
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
  limit?: number;
  offset?: number;
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
  },

  assets: {
    list: (params: AssetListParams = {}): Promise<AssetOut[]> => {
      const qs = new URLSearchParams();
      if (params.q) qs.set('q', params.q);
      if (params.tags) qs.set('tags', params.tags);
      if (params.folder_id) qs.set('folder_id', params.folder_id);
      if (params.limit) qs.set('limit', String(params.limit));
      if (params.offset) qs.set('offset', String(params.offset));
      const query = qs.toString();
      return apiFetch(`/assets${query ? `?${query}` : ''}`);
    },

    get: (id: string): Promise<AssetOut> => apiFetch(`/asset/${id}`),

    upload: (file: File, opts: { folderId?: string; tags?: string[]; notes?: string } = {}): Promise<AssetOut> => {
      const fd = new FormData();
      fd.append('file', file);
      if (opts.folderId) fd.append('folder_id', opts.folderId);
      if (opts.tags?.length) fd.append('tags', opts.tags.join(','));
      if (opts.notes) fd.append('notes', opts.notes);
      return apiFetch('/upload', { method: 'POST', body: fd });
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

    delete: (id: string, opts?: { deleteFile?: boolean }): Promise<void> =>
      apiFetch(`/asset/${id}?delete_file=${opts?.deleteFile ?? true}`, { method: 'DELETE' }),

    extractMeta: (id: string): Promise<AssetOut> =>
      apiFetch(`/asset/${id}/extract-meta`, { method: 'POST' }),

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

  import: {
    scan: (): Promise<ScanResult> => apiFetch('/import/scan', { method: 'POST' }),
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
  },
};
