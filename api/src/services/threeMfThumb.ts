// 3MF thumbnail extractor.
//
// 3MF files are zip containers (Open Packaging Conventions). Slicers
// like Bambu Studio, PrusaSlicer, OrcaSlicer, and SuperSlicer write a
// preview image into the package at `Metadata/thumbnail.png` (per the
// 3MF spec extension) and often additional plate-specific thumbs at
// `Metadata/plate_N.png`. We extract the highest-priority PNG we find;
// caller pipes it through sharp.
//
// Returns the PNG buffer, or null if no preview image was found.
// Falling back to mesh rendering for those is the caller's choice —
// for huge 3MFs without an embedded preview, the safer behavior is
// to mark thumb_status='none' rather than risk a Chromium OOM (which
// is what landed us here in the first place).

import yauzl from 'yauzl';

// Canonical path first, then plate-specific previews, then any PNG
// inside the Metadata folder as a last resort. Slicer behavior varies.
const PREVIEW_PATTERNS: RegExp[] = [
  /^metadata\/thumbnail\.png$/i,
  /^metadata\/plate_\d+\.png$/i,
  /^metadata\/[^\/]*\.png$/i,
];

function priority(name: string): number {
  for (let i = 0; i < PREVIEW_PATTERNS.length; i++) {
    if (PREVIEW_PATTERNS[i].test(name)) return i;
  }
  return -1;
}

export function extract3mfThumbnail(filePath: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) { resolve(null); return; }

      // We accumulate buffers from any matching entry as we encounter
      // them — yauzl's lazyEntries mode requires openReadStream to
      // happen synchronously inside the entry handler, so we can't
      // defer to a single "best match" decision at end-of-archive.
      // Instead, hold onto each candidate's buffer + priority and
      // resolve with the best one when end fires.
      let best: { buf: Buffer; pri: number } | null = null;
      let pendingReads = 0;
      let ended = false;

      function maybeResolve() {
        if (ended && pendingReads === 0) resolve(best ? best.buf : null);
      }

      zipfile.on('entry', (entry: yauzl.Entry) => {
        const pri = priority(entry.fileName);
        if (pri === -1) { zipfile.readEntry(); return; }

        pendingReads++;
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2 || !stream) {
            pendingReads--;
            zipfile.readEntry();
            maybeResolve();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (!best || pri < best.pri) best = { buf, pri };
            pendingReads--;
            zipfile.readEntry();
            maybeResolve();
          });
          stream.on('error', () => {
            pendingReads--;
            zipfile.readEntry();
            maybeResolve();
          });
        });
      });

      zipfile.on('end', () => { ended = true; maybeResolve(); });
      zipfile.on('error', () => { ended = true; maybeResolve(); });
      zipfile.readEntry();
    });
  });
}
