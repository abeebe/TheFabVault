import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { AssetMeta } from '../types/index.js';
import { thumbFilePath } from './fileStore.js';
import { dxfToSvg } from './dxfToSvg.js';

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract metadata from a stored asset file.
 * Returns a (possibly partial) AssetMeta object — only determinable fields are set.
 */
export async function extractMeta(filePath: string): Promise<AssetMeta> {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return await extractImageMeta(filePath);
    if (ext === '.svg') return extractSvgMeta(filePath);
    if (ext === '.dxf') return extractDxfMeta(filePath);
    if (ext === '.stl') return extractStlMeta(filePath);
    if (ext === '.obj') return extractObjMeta(filePath);
    if (ext === '.3mf') return await extract3mfMeta(filePath);
    if (['.gcode', '.gc', '.g'].includes(ext)) return extractGcodeMeta(filePath);
  } catch (err) {
    console.warn(`[metaExtract] Failed for ${filePath}:`, err);
  }
  return {};
}

/**
 * For GCode files: extract the embedded slicer thumbnail (PrusaSlicer / Bambu / Orca)
 * and save it to the thumbs directory. Returns true if a thumbnail was saved.
 */
export async function extractGCodeThumbnail(filePath: string, assetId: string): Promise<boolean> {
  try {
    const b64 = readEmbeddedThumbnail(filePath);
    if (!b64) return false;
    const buf = Buffer.from(b64, 'base64');
    const dest = thumbFilePath(assetId);
    await sharp(buf).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 88 }).toFile(dest);
    return true;
  } catch (err) {
    console.warn(`[metaExtract] GCode thumbnail extraction failed for ${assetId}:`, err);
    return false;
  }
}

// ─── Image metadata ────────────────────────────────────────────────────────────

async function extractImageMeta(filePath: string): Promise<AssetMeta> {
  const info = await sharp(filePath).metadata();
  return {
    width: info.width,
    height: info.height,
    colorSpace: info.space,
    channels: info.channels,
    hasAlpha: info.hasAlpha,
    dpi: info.density,
  };
}

// ─── SVG metadata ──────────────────────────────────────────────────────────────

function extractSvgMeta(filePath: string): AssetMeta {
  const content = fs.readFileSync(filePath, 'utf8').slice(0, 4096);
  const svgMatch = content.match(/<svg[^>]*>/i);
  if (!svgMatch) return {};
  const tag = svgMatch[0];

  const width    = (tag.match(/\bwidth\s*=\s*["']([^"']+)["']/i) ?? [])[1];
  const height   = (tag.match(/\bheight\s*=\s*["']([^"']+)["']/i) ?? [])[1];
  const viewBox  = (tag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i) ?? [])[1];

  return { svgWidth: width, svgHeight: height, svgViewBox: viewBox };
}

// ─── DXF metadata ─────────────────────────────────────────────────────────────

function extractDxfMeta(filePath: string): AssetMeta {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { stats } = dxfToSvg(content);

  const meta: AssetMeta = {
    dxfEntityCount: stats.entityCount,
    dxfEntityTypes: stats.entityTypes,
  };

  if (stats.bounds) {
    meta.dxfBounds = {
      width: round2(stats.bounds.maxX - stats.bounds.minX),
      height: round2(stats.bounds.maxY - stats.bounds.minY),
    };
  }

  return meta;
}

// ─── STL metadata ─────────────────────────────────────────────────────────────

function extractStlMeta(filePath: string): AssetMeta {
  const buf = fs.readFileSync(filePath);

  // Heuristic: if the first 256 bytes contain "facet", treat as ASCII
  const isAscii = buf.slice(0, 256).includes(Buffer.from('facet'));
  return isAscii ? extractAsciiStlMeta(buf.toString('utf8')) : extractBinaryStlMeta(buf);
}

function extractBinaryStlMeta(buf: Buffer): AssetMeta {
  if (buf.length < 84) return {};
  const triCount = buf.readUInt32LE(80);
  const expected = 84 + triCount * 50;
  if (buf.length < expected) return {};

  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (let i = 0; i < triCount; i++) {
    const base = 84 + i * 50 + 12; // skip 12-byte normal vector
    for (let v = 0; v < 3; v++) {
      const off = base + v * 12;
      const x = buf.readFloatLE(off);
      const y = buf.readFloatLE(off + 4);
      const z = buf.readFloatLE(off + 8);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }

  const bbox = triCount > 0 && isFinite(maxX) ? {
    x: round2(maxX - minX),
    y: round2(maxY - minY),
    z: round2(maxZ - minZ),
  } : undefined;

  return { triangleCount: triCount, boundingBox: bbox };
}

function extractAsciiStlMeta(text: string): AssetMeta {
  const triCount = (text.match(/facet normal/gi) ?? []).length;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const vertexRe = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(text)) !== null) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const bbox = isFinite(maxX) ? {
    x: round2(maxX - minX),
    y: round2(maxY - minY),
    z: round2(maxZ - minZ),
  } : undefined;

  return { triangleCount: triCount, boundingBox: bbox };
}

// ─── OBJ metadata ─────────────────────────────────────────────────────────────

function extractObjMeta(filePath: string): AssetMeta {
  const text = fs.readFileSync(filePath, 'utf8');
  let faceCount = 0;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('f ')) {
      faceCount++;
    } else if (t.startsWith('v ')) {
      const parts = t.split(/\s+/);
      if (parts.length >= 4) {
        const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
        if (!isNaN(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x; }
        if (!isNaN(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
        if (!isNaN(z)) { if (z < minZ) minZ = z; if (z > maxZ) maxZ = z; }
      }
    }
  }

  const bbox = isFinite(maxX) ? {
    x: round2(maxX - minX),
    y: round2(maxY - minY),
    z: round2(maxZ - minZ),
  } : undefined;

  return { triangleCount: faceCount, boundingBox: bbox };
}

// ─── 3MF metadata ─────────────────────────────────────────────────────────────

async function extract3mfMeta(filePath: string): Promise<AssetMeta> {
  // Use yauzl (already a transitive dependency via extract-zip / puppeteer)
  const yauzl = await import('yauzl').catch(() => null);
  if (!yauzl) return {};

  const xml = await new Promise<string | null>((resolve) => {
    yauzl.open(filePath, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) { resolve(null); return; }
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (entry.fileName.toLowerCase().endsWith('3dmodel.model')) {
          zipfile.openReadStream(entry, (err2, stream) => {
            if (err2 || !stream) { resolve(null); return; }
            const chunks: Buffer[] = [];
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            stream.on('error', () => resolve(null));
          });
        } else {
          zipfile.readEntry();
        }
      });
      zipfile.on('end', () => resolve(null));
      zipfile.on('error', () => resolve(null));
    });
  });

  if (!xml) return {};

  const triCount = (xml.match(/<triangle\b/gi) ?? []).length;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;

  const vRe = /<vertex\b[^>]*\bx="([-\d.eE+]+)"[^>]*\by="([-\d.eE+]+)"[^>]*\bz="([-\d.eE+]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = vRe.exec(xml)) !== null) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  const bbox = isFinite(maxX) ? {
    x: round2(maxX - minX),
    y: round2(maxY - minY),
    z: round2(maxZ - minZ),
  } : undefined;

  return { triangleCount: triCount, boundingBox: bbox };
}

// ─── GCode metadata ───────────────────────────────────────────────────────────

function extractGcodeMeta(filePath: string): AssetMeta {
  // Read the first 512 KB — enough for all header comments
  const MAX_BYTES = 512 * 1024;
  const stat = fs.statSync(filePath);
  const readSize = Math.min(stat.size, MAX_BYTES);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, readSize, 0);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  const lines = text.split('\n').slice(0, 600);
  const meta: AssetMeta = {};

  // ─ Slicer detection ─
  for (const line of lines) {
    const l = line.trim();
    if (/generated by prusaslicer/i.test(l))   { meta.slicer = 'PrusaSlicer'; break; }
    if (/generated by bambu studio/i.test(l))  { meta.slicer = 'Bambu Studio'; break; }
    if (/generated by superslicer/i.test(l))   { meta.slicer = 'SuperSlicer'; break; }
    if (/generated by orcaslicer/i.test(l))    { meta.slicer = 'OrcaSlicer'; break; }
    if (/cura_version/i.test(l) || /Generated with Cura/i.test(l)) { meta.slicer = 'Cura'; break; }
    if (/;FLAVOR:/i.test(l))                   { meta.slicer = 'Cura'; break; }
    if (/Simplify3D/i.test(l))                 { meta.slicer = 'Simplify3D'; break; }
    if (/KISSlicer/i.test(l))                  { meta.slicer = 'KISSlicer'; break; }
  }

  for (const line of lines) {
    const l = line.trim();

    // Layer count (all slicers)
    applyMatch(l, /^;\s*LAYER_COUNT\s*[:=]\s*(\d+)/i,
      (v) => { if (!meta.layerCount) meta.layerCount = parseInt(v, 10); });

    // Layer height
    applyMatch(l, /^;\s*(?:layer_height|LAYER_HEIGHT)\s*[:=]\s*([\d.]+)/i,
      (v) => { if (!meta.layerHeight) meta.layerHeight = parseFloat(v); });

    // PrusaSlicer / Orca / Bambu filament
    applyMatch(l, /^;\s*filament used \[mm\]\s*=\s*([\d.]+)/i,
      (v) => { meta.filamentUsedMm = parseFloat(v); });
    applyMatch(l, /^;\s*filament used \[g\]\s*=\s*([\d.]+)/i,
      (v) => { meta.filamentUsedG = parseFloat(v); });

    // Print time (PrusaSlicer / Orca / Bambu)
    applyMatch(l, /^;\s*estimated printing time(?: \(normal mode\))?\s*=\s*(.+)/i, (v) => {
      meta.printTimeFormatted = v.trim();
      meta.printTimeSeconds = parseHumanTime(v.trim());
    });

    // Cura time (in seconds)
    applyMatch(l, /^;TIME\s*:\s*(\d+)/i, (v) => {
      if (!meta.printTimeSeconds) {
        meta.printTimeSeconds = parseInt(v, 10);
        meta.printTimeFormatted = formatSeconds(meta.printTimeSeconds);
      }
    });

    // Cura filament (in metres)
    applyMatch(l, /^;Filament used\s*:\s*([\d.]+)\s*m/i,
      (v) => { if (!meta.filamentUsedMm) meta.filamentUsedMm = parseFloat(v) * 1000; });

    // Nozzle / bed temp from slicer comments
    applyMatch(l, /^;\s*(?:temperature|nozzle_temperature|first_layer_temperature)\s*=\s*([\d.]+)/i,
      (v) => { if (!meta.nozzleTemp) meta.nozzleTemp = parseFloat(v); });
    applyMatch(l, /^;\s*(?:bed_temperature|bed_temp|first_layer_bed_temperature)\s*=\s*([\d.]+)/i,
      (v) => { if (!meta.bedTemp) meta.bedTemp = parseFloat(v); });

    applyMatch(l, /^;\s*nozzle_diameter\s*=\s*([\d.]+)/i,
      (v) => { if (!meta.nozzleDiameter) meta.nozzleDiameter = parseFloat(v); });
    applyMatch(l, /^;NOZZLE_DIAMETER\s*:\s*([\d.]+)/i,
      (v) => { if (!meta.nozzleDiameter) meta.nozzleDiameter = parseFloat(v); });

    applyMatch(l, /^;\s*filament_type\s*=\s*(.+)/i,
      (v) => { meta.filamentType = v.trim(); });

    applyMatch(l, /^;\s*(?:slic3r_version|prusaslicer_version|bambu_studio_version|orca_version)\s*=\s*([\d.]+)/i,
      (v) => { meta.slicerVersion = v; });
    applyMatch(l, /^;cura_version\s*=\s*([\d.]+)/i,
      (v) => { if (!meta.slicerVersion) meta.slicerVersion = v; });
  }

  // Fall back: scan M104/M109 for nozzle temp, M140/M190 for bed temp
  if (!meta.nozzleTemp || !meta.bedTemp) {
    for (const line of lines) {
      const u = line.trim().toUpperCase();
      if (!meta.nozzleTemp) {
        const m = u.match(/^M10[49]\s+S(\d+)/);
        if (m) meta.nozzleTemp = parseInt(m[1], 10);
      }
      if (!meta.bedTemp) {
        const m = u.match(/^M1(?:40|90)\s+S(\d+)/);
        if (m) meta.bedTemp = parseInt(m[1], 10);
      }
      if (meta.nozzleTemp && meta.bedTemp) break;
    }
  }

  return meta;
}

/** Read the base64 thumbnail embedded by PrusaSlicer / Bambu / OrcaSlicer */
function readEmbeddedThumbnail(filePath: string): string | null {
  const MAX_SCAN = 1024 * 1024;
  const stat = fs.statSync(filePath);
  const readSize = Math.min(stat.size, MAX_SCAN);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, readSize, 0);
  fs.closeSync(fd);

  const text = buf.toString('utf8');
  // "; thumbnail begin WxH BYTES\n; <base64>\n; thumbnail end"
  const m = text.match(/;\s*thumbnail begin\s+\d+x\d+\s+\d+\s*\n([\s\S]*?);\s*thumbnail end/i);
  if (!m) return null;

  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*;\s*/, '').trim())
    .filter(Boolean)
    .join('');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function applyMatch(line: string, re: RegExp, fn: (val: string) => void): void {
  const m = line.match(re);
  if (m) fn(m[1]);
}

function parseHumanTime(str: string): number {
  // "2h 30m 15s", "1d 2h", "45m 20s", "3600"
  let seconds = 0;
  const d = str.match(/(\d+)\s*d/i); if (d) seconds += parseInt(d[1]) * 86400;
  const h = str.match(/(\d+)\s*h/i); if (h) seconds += parseInt(h[1]) * 3600;
  const m = str.match(/(\d+)\s*m(?!s)/i); if (m) seconds += parseInt(m[1]) * 60;
  const s = str.match(/(\d+)\s*s/i); if (s) seconds += parseInt(s[1]);
  if (seconds === 0 && /^\d+$/.test(str.trim())) seconds = parseInt(str.trim());
  return seconds;
}

function formatSeconds(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}
