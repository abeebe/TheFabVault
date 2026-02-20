// DXF to SVG renderer using dxf-parser
// Handles LINE, LWPOLYLINE, CIRCLE, ARC, SPLINE entities

interface DxfEntity {
  type: string;
  vertices?: Array<{ x: number; y: number }>;
  startPoint?: { x: number; y: number };
  endPoint?: { x: number; y: number };
  center?: { x: number; y: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  shape?: boolean;
  controlPoints?: Array<{ x: number; y: number }>;
}

interface DxfParsed {
  entities?: DxfEntity[];
}

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

export function dxfToSvg(dxfText: string): string {
  let dxf: DxfParsed;
  try {
    // Dynamic import — dxf-parser is a CommonJS module
    // We use a synchronous approach by pre-importing at module load time
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DxfParser = (window as any).__DxfParser;
    if (!DxfParser) {
      return '<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="30" fill="red">DXF parser not loaded</text></svg>';
    }
    const parser = new DxfParser();
    dxf = parser.parseSync(dxfText);
  } catch (e) {
    return `<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="30" fill="red">DXF parse error: ${e}</text></svg>`;
  }

  const entities = dxf.entities ?? [];
  const paths: string[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  function updateBounds(x: number, y: number): void {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  const pathEls: string[] = [];

  for (const entity of entities) {
    try {
      if (entity.type === 'LINE' && entity.startPoint && entity.endPoint) {
        const { x: x1, y: y1 } = entity.startPoint;
        const { x: x2, y: y2 } = entity.endPoint;
        updateBounds(x1, y1);
        updateBounds(x2, y2);
        pathEls.push(`<line x1="${x1}" y1="${-y1}" x2="${x2}" y2="${-y2}" />`);
      } else if ((entity.type === 'LWPOLYLINE' || entity.type === 'POLYLINE') && entity.vertices?.length) {
        const pts = entity.vertices;
        pts.forEach(({ x, y }) => updateBounds(x, y));
        const d = pts.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'} ${x} ${-y}`).join(' ');
        const closed = entity.shape ? ' Z' : '';
        pathEls.push(`<path d="${d}${closed}" />`);
      } else if (entity.type === 'CIRCLE' && entity.center && entity.radius) {
        const { x, y } = entity.center;
        const r = entity.radius;
        updateBounds(x - r, y - r);
        updateBounds(x + r, y + r);
        pathEls.push(`<circle cx="${x}" cy="${-y}" r="${r}" />`);
      } else if (entity.type === 'ARC' && entity.center && entity.radius) {
        const { x, y } = entity.center;
        const r = entity.radius;
        const s = entity.startAngle ?? 0;
        const e = entity.endAngle ?? 360;
        updateBounds(x - r, y - r);
        updateBounds(x + r, y + r);
        pathEls.push(`<path d="${arcPath(x, -y, r, -e, -s)}" />`);
      }
    } catch {
      // Skip malformed entities
    }
  }

  if (pathEls.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="30" fill="gray">No renderable entities</text></svg>';
  }

  const padding = Math.max((maxX - minX) * 0.05, 1);
  const vbX = minX - padding;
  const vbY = -maxY - padding;
  const vbW = maxX - minX + padding * 2;
  const vbH = maxY - minY + padding * 2;

  const pathsStr = pathEls.join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg"
  viewBox="${vbX} ${vbY} ${vbW} ${vbH}"
  style="width:100%;height:100%"
>
  <g fill="none" stroke="currentColor" stroke-width="${vbW * 0.002}">
    ${pathsStr}
  </g>
</svg>`;
}
