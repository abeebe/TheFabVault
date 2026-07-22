// Hand-built, uncompressed ("stored") ZIP file writer for tests only.
//
// Why not `archiver` (already a dependency, used elsewhere for zip
// creation): archiver normalizes/sanitizes entry names when you append
// them — a `../../evil.txt` name comes back out as `evil.txt` once
// finalized. That's exactly the behavior the zip-slip tests need to NOT
// have, since the whole point is exercising extractZip/resolveContainedPath
// against a REAL archive containing a genuinely hostile entry name.
// Building the handful of ZIP structures by hand (local file header +
// central directory + end-of-central-directory record, method=0/stored,
// no compression) gives full control over what bytes actually end up in
// the archive's central directory, with no library in the way to second-
// guess the entry name.
//
// Deliberately minimal: single disk, no zip64, no extra fields, no
// comments — everything this test suite needs and nothing it doesn't.

import zlib from 'zlib';

export interface RawZipEntryInput {
  name: string;
  content: string;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

export function buildRawZip(entries: RawZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const contentBuf = Buffer.from(entry.content, 'utf8');
    const crc = zlib.crc32(contentBuf) >>> 0;

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0), // flags
      u16(0), // compression method: stored
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(contentBuf.length), // compressed size == uncompressed (stored)
      u32(contentBuf.length),
      u16(nameBuf.length),
      u16(0), // extra field length
      nameBuf,
    ]);
    const localEntry = Buffer.concat([localHeader, contentBuf]);
    localParts.push(localEntry);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20), // version made by
      u16(20), // version needed
      u16(0), // flags
      u16(0), // compression method
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(contentBuf.length),
      u32(contentBuf.length),
      u16(nameBuf.length),
      u16(0), // extra field length
      u16(0), // comment length
      u16(0), // disk number start
      u16(0), // internal attrs
      u32(0), // external attrs
      u32(offset), // relative offset of local header
      nameBuf,
    ]);
    centralParts.push(centralHeader);

    offset += localEntry.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const centralOffset = localSection.length;

  const endRecord = Buffer.concat([
    u32(0x06054b50),
    u16(0), // disk number
    u16(0), // disk with central directory
    u16(entries.length), // entries on this disk
    u16(entries.length), // total entries
    u32(centralSection.length),
    u32(centralOffset),
    u16(0), // comment length
  ]);

  return Buffer.concat([localSection, centralSection, endRecord]);
}
