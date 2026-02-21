import type { PrinterSettings, LaserSettings, VinylSettings } from '../types/index.js';

// ─── Printer ──────────────────────────────────────────────────────────────────

interface PrinterFormProps {
  settings: PrinterSettings;
  onChange: (s: PrinterSettings) => void;
  /** If true, a checkbox per field lets the user enable/disable (for overrides) */
  overrideMode?: boolean;
  /** Active override keys when overrideMode=true */
  activeKeys?: Set<string>;
  onToggleKey?: (key: string) => void;
}

export function PrinterSettingsForm({ settings, onChange, overrideMode, activeKeys, onToggleKey }: PrinterFormProps) {
  function field<K extends keyof PrinterSettings>(
    key: K,
    label: string,
    input: React.ReactNode,
  ) {
    const active = !overrideMode || (activeKeys?.has(key) ?? false);
    return (
      <div key={key} className="flex items-center gap-3">
        {overrideMode && (
          <input
            type="checkbox"
            checked={active}
            onChange={() => onToggleKey?.(key)}
            className="accent-accent shrink-0"
          />
        )}
        <label className={`w-32 text-xs shrink-0 ${!active ? 'text-gray-300 dark:text-gray-600' : 'text-gray-500 dark:text-gray-400'}`}>
          {label}
        </label>
        <div className={`flex-1 ${!active ? 'opacity-40 pointer-events-none' : ''}`}>{input}</div>
      </div>
    );
  }

  const inp = 'w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent';
  const sel = inp;

  return (
    <div className="space-y-2.5">
      {field('material', 'Material',
        <select className={sel} value={settings.material ?? ''} onChange={(e) => onChange({ ...settings, material: e.target.value || undefined })}>
          <option value="">—</option>
          {['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'Nylon', 'HIPS', 'Other'].map((m) => <option key={m}>{m}</option>)}
        </select>
      )}
      {field('nozzleDiameter', 'Nozzle dia. (mm)',
        <input className={inp} type="number" step="0.1" min="0.1" max="2"
          value={settings.nozzleDiameter ?? ''} placeholder="0.4"
          onChange={(e) => onChange({ ...settings, nozzleDiameter: e.target.value ? parseFloat(e.target.value) : undefined })} />
      )}
      {field('nozzleTemp', 'Nozzle temp (°C)',
        <input className={inp} type="number" step="1" min="150" max="350"
          value={settings.nozzleTemp ?? ''} placeholder="200"
          onChange={(e) => onChange({ ...settings, nozzleTemp: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('bedTemp', 'Bed temp (°C)',
        <input className={inp} type="number" step="1" min="0" max="150"
          value={settings.bedTemp ?? ''} placeholder="60"
          onChange={(e) => onChange({ ...settings, bedTemp: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('layerHeight', 'Layer height (mm)',
        <input className={inp} type="number" step="0.05" min="0.05" max="1"
          value={settings.layerHeight ?? ''} placeholder="0.2"
          onChange={(e) => onChange({ ...settings, layerHeight: e.target.value ? parseFloat(e.target.value) : undefined })} />
      )}
      {field('printSpeed', 'Print speed (mm/s)',
        <input className={inp} type="number" step="5" min="10" max="500"
          value={settings.printSpeed ?? ''} placeholder="60"
          onChange={(e) => onChange({ ...settings, printSpeed: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('infillPercent', 'Infill (%)',
        <input className={inp} type="number" step="5" min="0" max="100"
          value={settings.infillPercent ?? ''} placeholder="20"
          onChange={(e) => onChange({ ...settings, infillPercent: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('supports', 'Supports',
        <input type="checkbox" className="accent-accent"
          checked={settings.supports ?? false}
          onChange={(e) => onChange({ ...settings, supports: e.target.checked })} />
      )}
      {field('brimWidthMm', 'Brim width (mm)',
        <input className={inp} type="number" step="1" min="0" max="30"
          value={settings.brimWidthMm ?? ''} placeholder="0"
          onChange={(e) => onChange({ ...settings, brimWidthMm: e.target.value ? parseFloat(e.target.value) : undefined })} />
      )}
    </div>
  );
}

// ─── Laser ────────────────────────────────────────────────────────────────────

interface LaserFormProps {
  settings: LaserSettings;
  onChange: (s: LaserSettings) => void;
  overrideMode?: boolean;
  activeKeys?: Set<string>;
  onToggleKey?: (key: string) => void;
}

export function LaserSettingsForm({ settings, onChange, overrideMode, activeKeys, onToggleKey }: LaserFormProps) {
  function field<K extends keyof LaserSettings>(key: K, label: string, input: React.ReactNode) {
    const active = !overrideMode || (activeKeys?.has(key) ?? false);
    return (
      <div key={key} className="flex items-center gap-3">
        {overrideMode && (
          <input type="checkbox" checked={active} onChange={() => onToggleKey?.(key)} className="accent-accent shrink-0" />
        )}
        <label className={`w-36 text-xs shrink-0 ${!active ? 'text-gray-300 dark:text-gray-600' : 'text-gray-500 dark:text-gray-400'}`}>{label}</label>
        <div className={`flex-1 ${!active ? 'opacity-40 pointer-events-none' : ''}`}>{input}</div>
      </div>
    );
  }

  const inp = 'w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <div className="space-y-2.5">
      {field('material', 'Material',
        <input className={inp} type="text" value={settings.material ?? ''} placeholder="Plywood, Acrylic…"
          onChange={(e) => onChange({ ...settings, material: e.target.value || undefined })} />
      )}
      {field('materialThicknessMm', 'Thickness (mm)',
        <input className={inp} type="number" step="0.5" min="0.1" max="50"
          value={settings.materialThicknessMm ?? ''} placeholder="3"
          onChange={(e) => onChange({ ...settings, materialThicknessMm: e.target.value ? parseFloat(e.target.value) : undefined })} />
      )}
      {field('powerPercent', 'Power (%)',
        <input className={inp} type="number" step="5" min="0" max="100"
          value={settings.powerPercent ?? ''} placeholder="80"
          onChange={(e) => onChange({ ...settings, powerPercent: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('speedMmMin', 'Speed (mm/min)',
        <input className={inp} type="number" step="10" min="1"
          value={settings.speedMmMin ?? ''} placeholder="1000"
          onChange={(e) => onChange({ ...settings, speedMmMin: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('passes', 'Passes',
        <input className={inp} type="number" step="1" min="1"
          value={settings.passes ?? ''} placeholder="1"
          onChange={(e) => onChange({ ...settings, passes: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('kerfMm', 'Kerf (mm)',
        <input className={inp} type="number" step="0.01" min="0"
          value={settings.kerfMm ?? ''} placeholder="0.1"
          onChange={(e) => onChange({ ...settings, kerfMm: e.target.value ? parseFloat(e.target.value) : undefined })} />
      )}
      {field('airAssist', 'Air assist',
        <input type="checkbox" className="accent-accent"
          checked={settings.airAssist ?? false}
          onChange={(e) => onChange({ ...settings, airAssist: e.target.checked })} />
      )}
    </div>
  );
}

// ─── Vinyl ────────────────────────────────────────────────────────────────────

interface VinylFormProps {
  settings: VinylSettings;
  onChange: (s: VinylSettings) => void;
  overrideMode?: boolean;
  activeKeys?: Set<string>;
  onToggleKey?: (key: string) => void;
}

export function VinylSettingsForm({ settings, onChange, overrideMode, activeKeys, onToggleKey }: VinylFormProps) {
  function field<K extends keyof VinylSettings>(key: K, label: string, input: React.ReactNode) {
    const active = !overrideMode || (activeKeys?.has(key) ?? false);
    return (
      <div key={key} className="flex items-center gap-3">
        {overrideMode && (
          <input type="checkbox" checked={active} onChange={() => onToggleKey?.(key)} className="accent-accent shrink-0" />
        )}
        <label className={`w-36 text-xs shrink-0 ${!active ? 'text-gray-300 dark:text-gray-600' : 'text-gray-500 dark:text-gray-400'}`}>{label}</label>
        <div className={`flex-1 ${!active ? 'opacity-40 pointer-events-none' : ''}`}>{input}</div>
      </div>
    );
  }

  const inp = 'w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent';

  return (
    <div className="space-y-2.5">
      {field('material', 'Material',
        <input className={inp} type="text" value={settings.material ?? ''} placeholder="Adhesive Vinyl, HTV…"
          onChange={(e) => onChange({ ...settings, material: e.target.value || undefined })} />
      )}
      {field('cuttingSpeed', 'Cutting speed',
        <input className={inp} type="number" step="10" min="1"
          value={settings.cuttingSpeed ?? ''} placeholder="100"
          onChange={(e) => onChange({ ...settings, cuttingSpeed: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('bladePressure', 'Blade pressure (g)',
        <input className={inp} type="number" step="5" min="0"
          value={settings.bladePressure ?? ''} placeholder="80"
          onChange={(e) => onChange({ ...settings, bladePressure: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('bladeDepth', 'Blade depth (mm)',
        <input className={inp} type="number" step="0.1" min="0" max="5"
          value={settings.bladeDepth ?? ''} placeholder="0.5"
          onChange={(e) => onChange({ ...settings, bladeDepth: e.target.value ? parseFloat(e.target.value) : undefined })} />
      )}
      {field('passes', 'Passes',
        <input className={inp} type="number" step="1" min="1"
          value={settings.passes ?? ''} placeholder="1"
          onChange={(e) => onChange({ ...settings, passes: e.target.value ? parseInt(e.target.value) : undefined })} />
      )}
      {field('mirrored', 'Mirror (HTV)',
        <input type="checkbox" className="accent-accent"
          checked={settings.mirrored ?? false}
          onChange={(e) => onChange({ ...settings, mirrored: e.target.checked })} />
      )}
    </div>
  );
}
