import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';
import type { AssetMeta, AssetOut } from '../types/index.js';

interface Props {
  asset: AssetOut;
  onRefresh: (updated: AssetOut) => void;
}

interface MetaRow {
  label: string;
  value: string;
}

function buildRows(meta: AssetMeta): MetaRow[] {
  const rows: MetaRow[] = [];

  // Images
  if (meta.width && meta.height) rows.push({ label: 'Dimensions', value: `${meta.width} × ${meta.height} px` });
  if (meta.colorSpace) rows.push({ label: 'Color space', value: meta.colorSpace });
  if (meta.channels) rows.push({ label: 'Channels', value: String(meta.channels) });
  if (meta.hasAlpha !== undefined) rows.push({ label: 'Alpha', value: meta.hasAlpha ? 'Yes' : 'No' });
  if (meta.dpi) rows.push({ label: 'DPI', value: String(meta.dpi) });

  // 3D models
  if (meta.triangleCount !== undefined) rows.push({ label: 'Triangles', value: meta.triangleCount.toLocaleString() });
  if (meta.boundingBox) {
    const { x, y, z } = meta.boundingBox;
    rows.push({ label: 'Bounding box', value: `${x} × ${y} × ${z} mm` });
  }

  // GCode
  if (meta.slicer) {
    const slicerLabel = meta.slicerVersion ? `${meta.slicer} ${meta.slicerVersion}` : meta.slicer;
    rows.push({ label: 'Slicer', value: slicerLabel });
  }
  if (meta.printTimeFormatted) rows.push({ label: 'Print time', value: meta.printTimeFormatted });
  if (meta.layerCount !== undefined) rows.push({ label: 'Layers', value: meta.layerCount.toLocaleString() });
  if (meta.layerHeight !== undefined) rows.push({ label: 'Layer height', value: `${meta.layerHeight} mm` });
  if (meta.filamentType) rows.push({ label: 'Filament', value: meta.filamentType });
  if (meta.filamentUsedMm !== undefined) rows.push({ label: 'Filament used', value: `${(meta.filamentUsedMm / 1000).toFixed(2)} m` });
  if (meta.filamentUsedG !== undefined) rows.push({ label: 'Filament weight', value: `${meta.filamentUsedG.toFixed(2)} g` });
  if (meta.nozzleTemp !== undefined) rows.push({ label: 'Nozzle temp', value: `${meta.nozzleTemp}°C` });
  if (meta.bedTemp !== undefined) rows.push({ label: 'Bed temp', value: `${meta.bedTemp}°C` });
  if (meta.nozzleDiameter !== undefined) rows.push({ label: 'Nozzle dia.', value: `${meta.nozzleDiameter} mm` });

  // SVG
  if (meta.svgWidth || meta.svgHeight) {
    rows.push({ label: 'Canvas', value: `${meta.svgWidth ?? '?'} × ${meta.svgHeight ?? '?'}` });
  }
  if (meta.svgViewBox) rows.push({ label: 'ViewBox', value: meta.svgViewBox });

  return rows;
}

export function MetaPanel({ asset, onRefresh }: Props) {
  const [refreshing, setRefreshing] = useState(false);
  const rows = buildRows(asset.meta);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const updated = await api.assets.extractMeta(asset.id);
      onRefresh(updated);
    } catch {
      // ignore
    } finally {
      setRefreshing(false);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-sm text-gray-400">
        <span>No metadata extracted.</span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="ml-auto flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Extracting…' : 'Extract metadata'}
        </button>
      </div>
    );
  }

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 px-4 py-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Metadata</span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Re-extract metadata"
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-accent disabled:opacity-50"
        >
          <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
        {rows.map(({ label, value }) => (
          <div key={label} className="contents">
            <dt className="text-xs text-gray-400 truncate">{label}</dt>
            <dd className="text-xs text-gray-700 dark:text-gray-200 font-medium truncate" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
