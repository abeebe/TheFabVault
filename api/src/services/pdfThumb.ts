// PDF thumbnail renderer.
//
// Uses Mozilla's pdf.js (pdfjs-dist, legacy build for Node) to render the
// first page of a PDF onto a @napi-rs/canvas surface, then converts the
// raw RGBA buffer to a JPEG via sharp. No system dependencies — both
// renderer and canvas are precompiled npm packages.
//
// Returns a JPEG buffer at roughly THUMB_WIDTH wide, preserving the
// PDF's aspect ratio. Throws if pdf.js can't open or render the page
// (corrupt/encrypted/empty PDFs).

import fs from 'fs';
import { createCanvas } from '@napi-rs/canvas';
import sharp from 'sharp';
// Legacy build avoids the worker setup that pdfjs-dist's default build
// expects in browsers; it runs synchronously in Node.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const THUMB_WIDTH = 512;

export async function renderPdfThumbnail(filePath: string): Promise<Buffer> {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({
    data,
    // Suppress font/eval warnings in the API logs for documents that
    // embed unusual font subsets — they don't affect rendering quality.
    verbosity: 0,
  }).promise;

  try {
    const page = await doc.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = THUMB_WIDTH / baseViewport.width;
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');

    // White background — PDFs often have transparent backgrounds and the
    // JPEG output would otherwise show garbage where the page is bare.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      // Required by pdfjs-dist 5.x; the canvas instance lets it manage
      // additional offscreen surfaces for blend modes / transparency.
      canvas: canvas as unknown as HTMLCanvasElement,
    }).promise;

    const rgba = canvas.toBuffer('image/png');
    return await sharp(rgba).jpeg({ quality: 82 }).toBuffer();
  } finally {
    await doc.destroy();
  }
}
