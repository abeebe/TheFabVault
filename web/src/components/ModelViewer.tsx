import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { ChevronDown, ExternalLink } from 'lucide-react';
import { Modal } from './Modal.js';
import { Spinner } from './Spinner.js';
import { GCodeViewer } from './GCodeViewer.js';
import { MetaPanel } from './MetaPanel.js';
import { StarRating } from './StarRating.js';
import { VersionPanel } from './VersionPanel.js';
import { dxfToSvg } from '../lib/dxf.js';
import { api } from '../lib/api.js';
import type { AssetOut } from '../types/index.js';

interface ModelViewerProps {
  asset: AssetOut;
  onClose: () => void;
  onUpdate?: (updated: AssetOut) => void;
}

const STL_EXTS = new Set(['.stl', '.obj', '.3mf']);
const SVG_EXTS = new Set(['.svg']);
const DXF_EXTS = new Set(['.dxf']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const GCODE_EXTS = new Set(['.gcode', '.gc', '.g']);

function getExt(filename: string): string {
  return filename.slice(filename.lastIndexOf('.')).toLowerCase();
}

function ThreeViewer({ asset }: { asset: AssetOut }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    let animId: number;
    let controls: OrbitControls;
    let renderer: THREE.WebGLRenderer;

    async function init() {
      try {
        // Fetch STL with auth token
        const fileUrl = api.assets.fileUrl(asset);
        const resp = await fetch(fileUrl);
        if (!resp.ok) throw new Error(`Failed to load file: ${resp.status}`);
        const buffer = await resp.arrayBuffer();

        renderer = new THREE.WebGLRenderer({ canvas: canvas!, antialias: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x1a1a2e);
        renderer.shadowMap.enabled = true;

        const w = container!.clientWidth;
        const h = container!.clientHeight;
        renderer.setSize(w, h);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x1a1a2e);

        const camera = new THREE.PerspectiveCamera(35, w / h, 0.001, 1000000);

        // Load geometry
        const loader = new STLLoader();
        const geometry = loader.parse(buffer);
        geometry.computeVertexNormals();
        geometry.center();
        geometry.computeBoundingSphere();

        const sphere = geometry.boundingSphere!;
        const dist = sphere.radius * 3.5;
        camera.position.set(dist, dist * 0.75, dist);
        camera.near = dist * 0.001;
        camera.far = dist * 100;
        camera.updateProjectionMatrix();
        camera.lookAt(0, 0, 0);

        const material = new THREE.MeshPhongMaterial({
          color: 0x4a9eff,
          specular: 0x222222,
          shininess: 30,
        });

        scene.add(new THREE.Mesh(geometry, material));

        // Grid helper
        const gridSize = sphere.radius * 4;
        const gridHelper = new THREE.GridHelper(gridSize, 20, 0x444466, 0x333355);
        gridHelper.position.y = -sphere.radius;
        scene.add(gridHelper);

        // Lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.4));
        const key = new THREE.DirectionalLight(0xffffff, 1.0);
        key.position.set(1, 2, 1.5);
        scene.add(key);
        const fill = new THREE.DirectionalLight(0x8888ff, 0.3);
        fill.position.set(-1, 0.5, -1);
        scene.add(fill);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.target.set(0, 0, 0);
        controls.update();

        // Resize observer
        const ro = new ResizeObserver(() => {
          if (!container || !renderer) return;
          const w2 = container.clientWidth;
          const h2 = container.clientHeight;
          renderer.setSize(w2, h2);
          camera.aspect = w2 / h2;
          camera.updateProjectionMatrix();
        });
        ro.observe(container!);

        function animate() {
          animId = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        }
        animate();
        setLoading(false);

        return () => {
          ro.disconnect();
          cancelAnimationFrame(animId);
          controls.dispose();
          renderer.dispose();
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }

    const cleanup = init();
    return () => {
      cleanup.then((fn) => fn?.());
      cancelAnimationFrame(animId);
    };
  }, [asset.id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={containerRef} className="relative w-full h-full bg-[#1a1a2e]">
      <canvas ref={canvasRef} className="w-full h-full" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size="lg" />
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-red-400 text-sm px-4 text-center">Failed to load model: {error}</p>
        </div>
      )}
      <div className="absolute bottom-3 right-3 text-xs text-gray-500 dark:text-gray-400 bg-black/40 px-2 py-1 rounded">
        Drag to rotate · Scroll to zoom · Right-drag to pan
      </div>
    </div>
  );
}

function SvgViewer({ asset }: { asset: AssetOut }) {
  const [svgContent, setSvgContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = api.assets.fileUrl(asset);
    fetch(url)
      .then((r) => r.text())
      .then((text) => {
        const ext = getExt(asset.filename);
        if (DXF_EXTS.has(ext)) {
          setSvgContent(dxfToSvg(text));
        } else {
          setSvgContent(text);
        }
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });
  }, [asset.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="flex items-center justify-center h-full"><Spinner size="lg" /></div>;
  if (error) return <div className="flex items-center justify-center h-full text-red-400">{error}</div>;

  return (
    <div
      className="w-full h-full flex items-center justify-center p-4 text-gray-700 dark:text-gray-300"
      dangerouslySetInnerHTML={{ __html: svgContent || '' }}
    />
  );
}

function ImageViewer({ asset }: { asset: AssetOut }) {
  const url = api.assets.fileUrl(asset);
  return (
    <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-900 p-4">
      <img src={url} alt={asset.filename} className="max-w-full max-h-full object-contain rounded" />
    </div>
  );
}

// ─── Slicer handoff ───────────────────────────────────────────────────────────

interface Slicer {
  name: string;
  scheme: (fileUrl: string) => string;
  note?: string;
}

const SLICERS: Slicer[] = [
  {
    name: 'OrcaSlicer',
    scheme: (url) => `orcaslicer://open?file=${encodeURIComponent(url)}`,
  },
  {
    name: 'PrusaSlicer',
    scheme: (url) => `prusaslicer://open?file=${encodeURIComponent(url)}`,
    note: 'May be restricted to Printables.com URLs',
  },
  {
    name: 'Bambu Studio',
    // bambu-connect:// needs a local path — fall back to download
    scheme: (url) => url,
    note: 'Download the file first, then open in Bambu Studio',
  },
  {
    name: 'Cura / download',
    scheme: (url) => url,
  },
];

function SlicerHandoff({ asset }: { asset: AssetOut }) {
  const [open, setOpen] = useState(false);
  const fileUrl = api.assets.fileUrl(asset);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
      >
        <ExternalLink size={14} /> Open in slicer <ChevronDown size={12} />
      </button>

      {open && (
        <>
          {/* Click-away backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 bottom-full mb-1 z-20 w-56 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 py-1 animate-fade-in">
            {SLICERS.map((slicer) => {
              const href = slicer.scheme(fileUrl);
              const isDownload = href === fileUrl;
              return (
                <a
                  key={slicer.name}
                  href={href}
                  download={isDownload ? asset.filename : undefined}
                  onClick={() => setOpen(false)}
                  className="flex flex-col px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{slicer.name}</span>
                  {slicer.note && (
                    <span className="text-xs text-gray-400 mt-0.5">{slicer.note}</span>
                  )}
                </a>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Main viewer export ───────────────────────────────────────────────────────

export function ModelViewer({ asset, onClose, onUpdate }: ModelViewerProps) {
  const [currentAsset, setCurrentAsset] = useState(asset);
  const ext = getExt(currentAsset.filename);

  function handleAssetUpdate(updated: AssetOut) {
    setCurrentAsset(updated);
    onUpdate?.(updated);
  }

  async function handleRatingChange(rating: number | null) {
    try {
      const updated = await api.assets.setRating(currentAsset.id, rating);
      handleAssetUpdate(updated);
    } catch {}
  }

  const isGCode = GCODE_EXTS.has(ext);
  const hasGraphicViewer = STL_EXTS.has(ext) || SVG_EXTS.has(ext) || DXF_EXTS.has(ext) || IMG_EXTS.has(ext);

  const ratingRow = (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 dark:border-gray-700">
      <span className="text-xs text-gray-500 dark:text-gray-400">Rating</span>
      <StarRating rating={currentAsset.rating} onChange={handleRatingChange} />
      {currentAsset.rating && (
        <span className="text-xs text-gray-400 ml-1">
          {['', 'Terrible', 'Poor', 'OK', 'Good', 'Great'][currentAsset.rating]}
        </span>
      )}
    </div>
  );

  return (
    <Modal
      title={currentAsset.originalName || currentAsset.filename}
      onClose={onClose}
      wide
    >
      {isGCode && (
        <>
          {ratingRow}
          <GCodeViewer asset={currentAsset} />
          <VersionPanel asset={currentAsset} onAssetUpdated={handleAssetUpdate} />
        </>
      )}
      {hasGraphicViewer && (
        <>
          <div className="h-[55vh]">
            {STL_EXTS.has(ext) && <ThreeViewer asset={currentAsset} />}
            {(SVG_EXTS.has(ext) || DXF_EXTS.has(ext)) && <SvgViewer asset={currentAsset} />}
            {IMG_EXTS.has(ext) && <ImageViewer asset={currentAsset} />}
          </div>
          {STL_EXTS.has(ext) && (
            <div className="flex justify-end px-4 pt-2">
              <SlicerHandoff asset={currentAsset} />
            </div>
          )}
          {ratingRow}
          <MetaPanel asset={currentAsset} onRefresh={handleAssetUpdate} />
          <VersionPanel asset={currentAsset} onAssetUpdated={handleAssetUpdate} />
        </>
      )}
      {!hasGraphicViewer && !isGCode && (
        <>
          {ratingRow}
          <div className="flex items-center justify-center py-10 text-gray-500">
            No preview available for this file type
          </div>
          <MetaPanel asset={currentAsset} onRefresh={handleAssetUpdate} />
          <VersionPanel asset={currentAsset} onAssetUpdated={handleAssetUpdate} />
        </>
      )}
    </Modal>
  );
}
