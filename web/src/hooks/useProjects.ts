import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';
import type { ProjectOut, ProjectDetailOut, ProjectOverrides } from '../types/index.js';

export function useProjects() {
  const [projects, setProjects] = useState<ProjectOut[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api.projects.list();
      setProjects(data);
    } catch (err) {
      console.error('[useProjects] Failed to fetch projects:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const createProject = useCallback(async (name: string, description?: string): Promise<ProjectOut> => {
    const project = await api.projects.create({ name, description });
    setProjects((prev) => [project, ...prev]);
    return project;
  }, []);

  const updateProject = useCallback(async (id: string, body: Parameters<typeof api.projects.update>[1]): Promise<ProjectOut> => {
    const updated = await api.projects.update(id, body);
    setProjects((prev) => prev.map((p) => p.id === id ? updated : p));
    return updated;
  }, []);

  const deleteProject = useCallback(async (id: string): Promise<void> => {
    await api.projects.delete(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  return { projects, loading, refresh, createProject, updateProject, deleteProject };
}

export function useProjectDetail(id: string | null) {
  const [project, setProject] = useState<ProjectDetailOut | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!id) { setProject(null); return; }
    setLoading(true);
    try {
      const data = await api.projects.get(id);
      setProject(data);
    } catch {
      setProject(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { refresh(); }, [refresh]);

  const addAssets = useCallback(async (assetIds: string[]) => {
    if (!id) return;
    await api.projects.addAssets(id, assetIds);
    await refresh();
  }, [id, refresh]);

  const removeAsset = useCallback(async (assetId: string) => {
    if (!id) return;
    await api.projects.removeAsset(id, assetId);
    setProject((prev) => prev ? {
      ...prev,
      assets: prev.assets.filter((a) => a.id !== assetId),
      assetCount: prev.assetCount - 1,
    } : null);
  }, [id]);

  const updateOverrides = useCallback(async (assetId: string, overrides: ProjectOverrides) => {
    if (!id) return;
    await api.projects.updateOverrides(id, assetId, overrides);
    setProject((prev) => prev ? {
      ...prev,
      assets: prev.assets.map((a) => a.id === assetId ? { ...a, overrides } : a),
    } : null);
  }, [id]);

  return { project, loading, refresh, addAssets, removeAsset, updateOverrides };
}
