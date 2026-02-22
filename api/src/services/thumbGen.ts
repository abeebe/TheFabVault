import fs from 'fs';
import path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import sharp from 'sharp';
import PQueue from 'p-queue';
import { getDb } from '../db.js';
import { assetFilePath, thumbFilePath } from './fileStore.js';
import { extractGCodeThumbnail } from './metaExtract.js';
import { dxfToSvg } from './dxfToSvg.js';
import type { AssetRow } from '../types/index.js';

const queue = new PQueue({ concurrency: 1 });
let browser: Browser | null = null;
let serverPort = 3000;
const MAX_RETRIES = 2;

const STL_EXTS = new Set(['.stl', '.obj', '.3mf']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);
const GCODE_EXTS = new Set(['.gcode', '.gc', '.g']);

export function setServerPort(port: number): void {
  serverPort = port;
}

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.connected) {
    const execPath = process.env.PUPPETEER_EXECUTABLE_PATH;
    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: execPath || undefined,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--use-gl=angle',                // Use ANGLE for WebGL
          '--use-angle=swiftshader-webgl',  // SwiftShader software renderer
          '--no-first-run',
          '--no-zygote',
        ],
      });
      browser.on('disconnected', () => { browser = null; });
      console.log('[thumbGen] Browser launched successfully',
        execPath ? `at ${execPath}` : '(bundled Chromium)');
    } catch (err) {
      console.error('[thumbGen] Failed to launch browser:', err);
      throw err;
    }
  }
  return browser;
}

async function renderWithPuppeteer(
  page: Page,
  assetId: string,
  filePath: string,
  ext: string,
  filename: string,
): Promise<void> {
  const rendererUrl = `http://localhost:${serverPort}/static/thumb-renderer.html`;

  await page.goto(rendererUrl, { waitUntil: 'networkidle0', timeout: 15000 });
  await page.setViewport({ width: 512, height: 512 });

  if (STL_EXTS.has(ext)) {
    // Use URL-based fetch — avoids piping large files through CDP as base64
    const fileUrl = `http://localhost:${serverPort}/internal/asset-raw/${assetId}/${encodeURIComponent(filename)}`;
    await page.evaluate((url: string) => {
      (window as unknown as Record<string, Function>).__renderSTLFromUrl(url);
    }, fileUrl);
  } else {
    // For images, base64 is fine (they're small)
    const fileBuffer = fs.readFileSync(filePath);
    const base64 = fileBuffer.toString('base64');
    const mimeMap: Record<string, string> = {
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    await page.evaluate((b64: string, mime: string) => {
      (window as unknown as Record<string, Function>).__renderImage(b64, mime);
    }, base64, mimeType);
  }

  await page.waitForFunction('window.__done === true', { timeout: 60000 });

  const errMsg = await page.evaluate(() => (window as unknown as Record<string, unknown>).__error);
  if (errMsg) {
    throw new Error(`Renderer error: ${errMsg}`);
  }

  const screenshotBuffer = await page.screenshot({ type: 'jpeg', quality: 88 });
  fs.writeFileSync(thumbFilePath(assetId), screenshotBuffer);
}

/**
 * Attempt Puppeteer render with retries.
 * On TargetCloseError (browser/page crash), kill the browser and relaunch.
 */
async function renderWithRetry(
  assetId: string,
  filePath: string,
  ext: string,
  filename: string,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    let page: Page | null = null;
    try {
      const b = await getBrowser();
      page = await b.newPage();
      await renderWithPuppeteer(page, assetId, filePath, ext, filename);
      return; // Success
    } catch (err: any) {
      const isTargetClosed =
        err?.constructor?.name === 'TargetCloseError' ||
        err?.message?.includes('Target closed') ||
        err?.message?.includes('Session closed') ||
        err?.message?.includes('Protocol error');

      if (isTargetClosed && attempt <= MAX_RETRIES) {
        console.warn(
          `[thumbGen] Browser crashed rendering ${assetId} (attempt ${attempt}/${MAX_RETRIES + 1}), restarting browser...`
        );
        // Force-kill the dead browser so getBrowser() launches a fresh one
        if (browser) {
          await browser.close().catch(() => {});
          browser = null;
        }
        // Brief pause before retry
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw err; // Non-retryable error or out of retries
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }
}

export async function generateThumb(assetId: string): Promise<void> {
  const db = getDb();
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(assetId) as AssetRow | undefined;
  if (!asset) return;

  const ext = path.extname(asset.filename).toLowerCase();
  const filePath = assetFilePath(assetId, asset.filename);
  const thumbOut = thumbFilePath(assetId);

  if (!fs.existsSync(filePath)) {
    db.prepare("UPDATE assets SET thumb_status = 'failed' WHERE id = ?").run(assetId);
    return;
  }

  try {
    if (ext === '.svg') {
      // sharp can rasterize SVG natively
      await sharp(filePath, { density: 144 })
        .resize(512, 512, { fit: 'inside', background: { r: 249, g: 250, b: 251, alpha: 1 } })
        .flatten({ background: { r: 249, g: 250, b: 251 } })
        .jpeg({ quality: 88 })
        .toFile(thumbOut);
      db.prepare("UPDATE assets SET thumb_status = 'done' WHERE id = ?").run(assetId);
      return;
    }

    if (ext === '.dxf') {
      // Parse DXF → SVG string, then rasterize with sharp
      const dxfText = fs.readFileSync(filePath, 'utf-8');
      const { svg } = dxfToSvg(dxfText);
      const svgBuffer = Buffer.from(svg, 'utf-8');
      await sharp(svgBuffer, { density: 144 })
        .resize(512, 512, { fit: 'inside', background: { r: 249, g: 250, b: 251, alpha: 1 } })
        .flatten({ background: { r: 249, g: 250, b: 251 } })
        .jpeg({ quality: 88 })
        .toFile(thumbOut);
      db.prepare("UPDATE assets SET thumb_status = 'done' WHERE id = ?").run(assetId);
      return;
    }

    if (IMG_EXTS.has(ext) && ext !== '.svg') {
      await sharp(filePath)
        .resize(512, 512, { fit: 'inside', withoutEnlargement: true, background: { r: 249, g: 250, b: 251, alpha: 1 } })
        .flatten({ background: { r: 249, g: 250, b: 251 } })
        .jpeg({ quality: 88 })
        .toFile(thumbOut);
      db.prepare("UPDATE assets SET thumb_status = 'done' WHERE id = ?").run(assetId);
      return;
    }

    if (STL_EXTS.has(ext)) {
      await renderWithRetry(assetId, filePath, ext, asset.filename);
      db.prepare("UPDATE assets SET thumb_status = 'done' WHERE id = ?").run(assetId);
      return;
    }

    if (GCODE_EXTS.has(ext)) {
      const found = await extractGCodeThumbnail(filePath, assetId);
      db.prepare(`UPDATE assets SET thumb_status = ? WHERE id = ?`)
        .run(found ? 'done' : 'none', assetId);
      return;
    }

    // No thumbnail for this type
    db.prepare("UPDATE assets SET thumb_status = 'none' WHERE id = ?").run(assetId);
  } catch (err) {
    console.error(`[thumbGen] Failed for ${assetId} (${asset.filename}):`, err);
    db.prepare("UPDATE assets SET thumb_status = 'failed' WHERE id = ?").run(assetId);
  }
}

export function enqueueThumb(assetId: string): void {
  queue.add(() => generateThumb(assetId).catch((err) => {
    console.error(`[thumbGen] Queue error for ${assetId}:`, err);
  }));
}

export function requeuePendingThumbs(): void {
  const db = getDb();
  const pending = db.prepare("SELECT id FROM assets WHERE thumb_status = 'pending'").all() as { id: string }[];
  if (pending.length > 0) {
    console.log(`[thumbGen] Re-queuing ${pending.length} pending thumbnails`);
    for (const row of pending) {
      enqueueThumb(row.id);
    }
  }
}

export async function shutdownBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}
