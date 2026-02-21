import { useState } from 'react';
import { Modal } from './Modal.js';
import { PrinterSettingsForm, LaserSettingsForm, VinylSettingsForm } from './SettingsForm.js';
import type {
  ProjectDetailOut, ProjectAssetOut, ProjectOverrides,
  PrinterSettings, LaserSettings, VinylSettings,
} from '../types/index.js';

interface Props {
  project: ProjectDetailOut;
  asset: ProjectAssetOut;
  onSave: (overrides: ProjectOverrides) => Promise<void>;
  onClose: () => void;
}

type Tab = 'printer' | 'laser' | 'vinyl';

export function AssetOverridesModal({ project, asset, onSave, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('printer');
  const [overrides, setOverrides] = useState<ProjectOverrides>(asset.overrides ?? {});
  const [saving, setSaving] = useState(false);

  // Track which keys are actively overridden per category
  const [printerKeys, setPrinterKeys] = useState<Set<string>>(
    new Set(Object.keys(overrides.printer ?? {}))
  );
  const [laserKeys, setLaserKeys] = useState<Set<string>>(
    new Set(Object.keys(overrides.laser ?? {}))
  );
  const [vinylKeys, setVinylKeys] = useState<Set<string>>(
    new Set(Object.keys(overrides.vinyl ?? {}))
  );

  function toggleKey(category: Tab, key: string) {
    const setFn = category === 'printer' ? setPrinterKeys : category === 'laser' ? setLaserKeys : setVinylKeys;
    setFn((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        // Remove this key from overrides
        setOverrides((o) => {
          const cat = { ...(o[category] ?? {}) } as Record<string, unknown>;
          delete cat[key];
          return { ...o, [category]: cat };
        });
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handlePrinterChange(s: PrinterSettings) {
    const filtered = Object.fromEntries(
      Object.entries(s).filter(([k]) => printerKeys.has(k))
    ) as Partial<PrinterSettings>;
    setOverrides((o) => ({ ...o, printer: filtered }));
  }

  function handleLaserChange(s: LaserSettings) {
    const filtered = Object.fromEntries(
      Object.entries(s).filter(([k]) => laserKeys.has(k))
    ) as Partial<LaserSettings>;
    setOverrides((o) => ({ ...o, laser: filtered }));
  }

  function handleVinylChange(s: VinylSettings) {
    const filtered = Object.fromEntries(
      Object.entries(s).filter(([k]) => vinylKeys.has(k))
    ) as Partial<VinylSettings>;
    setOverrides((o) => ({ ...o, vinyl: filtered }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await onSave(overrides);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'printer', label: 'Printer' },
    { id: 'laser', label: 'Laser' },
    { id: 'vinyl', label: 'Vinyl' },
  ];

  // Merged settings: project base + current overrides for preview
  const mergedPrinter = { ...project.printerSettings, ...(overrides.printer ?? {}) };
  const mergedLaser = { ...project.laserSettings, ...(overrides.laser ?? {}) };
  const mergedVinyl = { ...project.vinylSettings, ...(overrides.vinyl ?? {}) };

  return (
    <Modal
      title={`Overrides — ${asset.originalName ?? asset.filename}`}
      onClose={onClose}
      wide
    >
      <div className="text-xs text-gray-400 mb-3">
        Check a field to override the project default for this file. Unchecked fields inherit from the project.
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-200 dark:border-gray-700">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
              tab === t.id
                ? 'bg-accent text-white'
                : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-h-[280px]">
        {tab === 'printer' && (
          <PrinterSettingsForm
            settings={mergedPrinter}
            onChange={handlePrinterChange}
            overrideMode
            activeKeys={printerKeys}
            onToggleKey={(k) => toggleKey('printer', k)}
          />
        )}
        {tab === 'laser' && (
          <LaserSettingsForm
            settings={mergedLaser}
            onChange={handleLaserChange}
            overrideMode
            activeKeys={laserKeys}
            onToggleKey={(k) => toggleKey('laser', k)}
          />
        )}
        {tab === 'vinyl' && (
          <VinylSettingsForm
            settings={mergedVinyl}
            onChange={handleVinylChange}
            overrideMode
            activeKeys={vinylKeys}
            onToggleKey={(k) => toggleKey('vinyl', k)}
          />
        )}
      </div>

      <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        <button onClick={onClose} className="px-3 py-1.5 text-sm rounded text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save overrides'}
        </button>
      </div>
    </Modal>
  );
}
