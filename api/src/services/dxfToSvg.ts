// DXF to SVG converter for backend thumbnail generation
// Ported from web/src/lib/dxf.ts — uses dxf-parser to parse DXF text,
// then generates an SVG string that sharp can rasterize.

import DxfParser from 'dxf-parser';
import type { IEntity, IPoint } from 'dxf-parser';

function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function arcPath(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const start = deg2rad(startDeg);
  const end = deg2rad(endDeg);
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  let sweep = endDeg - startDeg;
  if (sweep < 0) sweep += 360;
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

interface DxfStats {
  entityCount: number;
  entityTypes: Record<string, number>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

/**
 * Convert DXF text content to an SVG string.
 * Returns { svg, stats } where svg is the SVG markup and stats has entity info.
 */
export function dxfToSvg(dxfText: string): { svg: string; stats: DxfStats } {
  const parser = new DxfParser();
  const dxf = parser.parseSync(dxfText);

  const entities: IEntity[] = (dxf as any)?.entities ?? [];
  const pathEls: string[] = [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const entityTypes: Record<string, number> = {};

  function updateBounds(x: number, y: number): void {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  for (const entity of entities) {
    entityTypes[entity.type] = (entityTypes[entity.type] || 0) + 1;

    try {
      const e = entity as any;

      if (entity.type === 'LINE' && e.vertices?.length >= 2) {
        const { x: x1, y: y1 } = e.vertices[0];
        const { x: x2, y: y2 } = e.vertices[1];
        updateBounds(x1, y1);
        updateBounds(x2, y2);
        pathEls.push(`<line x1="${x1}" y1="${-y1}" x2="${x2}" y2="${-y2}" />`);
      } else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && e.vertices?.length) {
        const pts: IPoint[] = e.vertices;
        pts.forEach(({ x, y }: IPoint) => updateBounds(x, y));
        const d = pts.map(({ x, y }: IPoint, i: number) => `${i === 0 ? 'M' : 'L'} ${x} ${-y}`).join(' ');
        const closed = e.shape ? ' Z' : '';
        pathEls.push(`<path d="${d}${closed}" />`);
      } else if (entity.type === 'CIRCLE' && e.center && e.radius) {
        const { x, y } = e.center;
        const r = e.radius;
        updateBounds(x - r, y - r);
        updateBounds(x + r, y + r);
        pathEls.push(`<circle cx="${x}" cy="${-y}" r="${r}" />`);
      } else if (entity.type === 'ARC' && e.center && e.radius) {
        const { x, y } = e.center;
        const r = e.radius;
        const s = e.startAngle ?? 0;
        const end = e.endAngle ?? 360;
        updateBounds(x - r, y - r);
        updateBounds(x + r, y + r);
        pathEls.push(`<path d="${arcPath(x, -y, r, -end, -s)}" />`);
      } else if (entity.type === 'ELLIPSE' && e.center && e.majorAxisEndPoint) {
        const { x: cx, y: cy } = e.center;
        const { x: mx, y: my } = e.majorAxisEndPoint;
        const majorR = Math.sqrt(mx * mx + my * my);
        const minorR = majorR * (e.axisRatio ?? 1);
        const angle = Math.atan2(my, mx) * (180 / Math.PI);
        updateBounds(cx - majorR, cy - majorR);
        updateBounds(cx + majorR, cy + majorR);
        pathEls.push(`<ellipse cx="${cx}" cy="${-cy}" rx="${majorR}" ry="${minorR}" transform="rotate(${-angle} ${cx} ${-cy})" />`);
      } else if (entity.type === 'SPLINE' && e.controlPoints?.length) {
        // Approximate spline as polyline through control points
        const pts: IPoint[] = e.controlPoints;
        pts.forEach(({ x, y }: IPoint) => updateBounds(x, y));
        const d = pts.map(({ x, y }: IPoint, i: number) => `${i === 0 ? 'M' : 'L'} ${x} ${-y}`).join(' ');
        pathEls.push(`<path d="${d}" />`);
      }
    } catch {
      // Skip malformed entities
    }
  }

  const stats: DxfStats = {
    entityCount: entities.length,
    entityTypes,
    bounds: minX < Infinity ? { minX, minY, maxX, maxY } : null,
  };

  if (pathEls.length === 0) {
    // Return a minimal SVG with placeholder text
    return {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#f9fafb"/><text x="256" y="256" text-anchor="middle" fill="#9ca3af" font-size="24">No renderable entities</text></svg>',
      stats,
    };
  }

  const padding = Math.max((maxX - minX) * 0.05, (maxY - minY) * 0.05, 1);
  const vbX = minX - padding;
  const vbY = -maxY - padding;
  const vbW = maxX - minX + padding * 2;
  const vbH = maxY - minY + padding * 2;
  const strokeW = Math.max(vbW, vbH) * 0.003;

  const pathsStr = pathEls.join('\n    ');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"
  viewBox="${vbX} ${vbY} ${vbW} ${vbH}"
>
  <rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="#f9fafb" />
  <g fill="none" stroke="#374151" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round">
    ${pathsStr}
  </g>
</svg>`;

  return { svg, stats };
}
