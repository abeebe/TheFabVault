// Builds the per-file resolution plan the Commit phase executes (see
// lib/importStore.ts's ImportResolution). Pulled out of the modal
// component into its own pure module so the same-batch dedup grouping —
// the core new behavioral delta this bet adds (Reid's UX spec, section
// 6.1 point 5) — is independently testable without mounting React or
// touching the network.

import type { ImportResolution } from './importStore.js';

export interface ScannedFile {
  file: File;
  segments: string[];
  hash: string;
  // The existing vault asset this file's hash already matches, from the
  // Scan phase's /check-hash call — null when this hash hasn't been seen
  // anywhere in the vault yet.
  vaultAssetId: string | null;
}

// Groups `scannedFiles` by hash and resolves each group to one of:
//   - every file in a group whose hash already exists in the vault
//     becomes 'vault-link', pointed at the existing asset — no upload.
//   - for a group with no vault match, the first file (scan order)
//     becomes 'new-upload'; every other file in that same group becomes
//     'batch-link', referencing the new-upload entry's index in the
//     returned array.
//
// Invariant callers (lib/importStore.ts's worker pool) depend on: for
// every 'batch-link' entry, representativeIndex is strictly less than
// that entry's own position in the returned array. This holds by
// construction — groups are processed in Map iteration order (insertion
// order in JS), and within a group the representative is always pushed
// before its dependents.
export function buildResolutions(scannedFiles: ScannedFile[]): ImportResolution[] {
  const groups = new Map<string, ScannedFile[]>();
  for (const sf of scannedFiles) {
    const arr = groups.get(sf.hash);
    if (arr) arr.push(sf);
    else groups.set(sf.hash, [sf]);
  }

  const resolutions: ImportResolution[] = [];

  for (const group of groups.values()) {
    const vaultAssetId = group.find((g) => g.vaultAssetId)?.vaultAssetId ?? null;

    if (vaultAssetId) {
      for (const g of group) {
        resolutions.push({ kind: 'vault-link', file: g.file, segments: g.segments, assetId: vaultAssetId });
      }
      continue;
    }

    const [representative, ...rest] = group;
    const representativeIndex = resolutions.length;
    resolutions.push({ kind: 'new-upload', file: representative.file, segments: representative.segments });
    for (const g of rest) {
      resolutions.push({ kind: 'batch-link', file: g.file, segments: g.segments, representativeIndex });
    }
  }

  return resolutions;
}
