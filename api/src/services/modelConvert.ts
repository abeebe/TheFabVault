// Pure classification for POST /models/from-folder (#2155, Phase A of
// the "Local MakerWorld" restructure — see
// Reports/derek-thefabvault-makerworld-restructure-plan-2026-07-22.md).
//
// Turns a flat list of a folder's assets into model_files role
// assignments + a cover pick. No DB access, no filesystem I/O — same
// shape as services/subAssemblyTree.ts's validateReparent: a plain
// function over plain data so it's directly unit-testable without
// booting a DB or an HTTP server. The route (routes/models.ts) is
// responsible for reading the folder's assets and writing the plan this
// produces; this module only decides the plan.
//
// Ext-to-role mapping reuses THREE_D_EXTS from routes/assets.ts (the
// existing 3dmodel/2d auto-category split) rather than a second,
// divergent extension list for "which files are 3D parts" — see that
// export's comment. Image and doc lists are new; assets.ts has no
// equivalent grouping for either (TWO_D_EXTS there covers vector/laser
// formats, not "picture of the finished print", and includes .pdf,
// which for a model is a doc, not an image — the two lists serve
// different questions and are allowed to overlap on .pdf without
// conflict).

import path from 'path';
import { THREE_D_EXTS } from '../routes/assets.js';
import type { ModelFileRole } from './enumValidators.js';

export const MODEL_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
export const MODEL_DOC_EXTS = new Set(['.pdf', '.txt', '.md']);

// Minimal shape needed to classify + pick a cover — a subset of AssetRow
// so callers don't need to construct a full row for tests/fixtures.
export interface ConvertibleAsset {
  assetId: string;
  filename: string;
  thumbStatus: 'none' | 'pending' | 'done' | 'failed';
}

export interface ClassifiedFile {
  assetId: string;
  role: ModelFileRole;
  sortOrder: number;
}

export interface FolderConversionPlan {
  files: ClassifiedFile[];
  // First image asset if one exists, else the first asset (in input
  // order) whose thumbnail has finished rendering, else null (nothing
  // usable yet — the model is created with no cover, same as any other
  // model with cover_asset_id unset).
  coverAssetId: string | null;
}

// Extension classification alone, exported separately from the
// full-folder planner so a single filename can be classified in
// isolation (e.g. by routes/models.ts's attach endpoint, which needs the
// same role inference for a single newly-uploaded file, not a whole
// folder).
export function classifyExt(filename: string): ModelFileRole {
  const ext = path.extname(filename).toLowerCase();
  if (MODEL_IMAGE_EXTS.has(ext)) return 'image';
  if (THREE_D_EXTS.has(ext)) return 'part';
  if (MODEL_DOC_EXTS.has(ext)) return 'doc';
  return 'other';
}

export function planFolderConversion(assets: ConvertibleAsset[]): FolderConversionPlan {
  const files: ClassifiedFile[] = assets.map((a, i) => ({
    assetId: a.assetId,
    role: classifyExt(a.filename),
    sortOrder: i,
  }));

  const firstImage = assets.find((a) => classifyExt(a.filename) === 'image');
  const coverAssetId = firstImage
    ? firstImage.assetId
    : (assets.find((a) => a.thumbStatus === 'done')?.assetId ?? null);

  return { files, coverAssetId };
}
