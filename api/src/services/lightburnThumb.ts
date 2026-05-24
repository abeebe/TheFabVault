// LightBurn (.lbrn / .lbrn2) thumbnail extractor.
//
// LightBurn embeds a base64-encoded PNG in the project XML when it saves,
// living in a <Thumbnail Source="..."/> element near the top of the file.
// Both .lbrn and .lbrn2 use the same shape. We don't need a full XML
// parser — the attribute is a single base64 string with no nested quotes
// to worry about — so a tight regex over the first chunk of the file is
// sufficient and avoids reading multi-MB shape trees into memory.
//
// Returns the decoded PNG buffer, or null if the file has no embedded
// thumbnail (older LightBurn versions or "save without thumbnail"
// preference). Caller is responsible for resizing/recoding via sharp.

import fs from 'fs';

// LightBurn places the <Thumbnail> within the first kilobyte or two of
// the file in practice; 64 KB is generous and bounds memory for huge
// projects with thousands of shapes.
const HEADER_BYTES = 64 * 1024;

const THUMB_RE = /<Thumbnail\s+Source\s*=\s*"([^"]+)"/i;

export function extractLightburnThumbnail(filePath: string): Buffer | null {
  let header: string;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
    header = buf.slice(0, bytesRead).toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }

  const match = header.match(THUMB_RE);
  if (!match) return null;

  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    return null;
  }
}
