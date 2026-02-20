import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Modal } from './Modal.js';
import { Spinner } from './Spinner.js';
import { dxfToSvg } from '../lib/dxf.js';
import { api } from '../lib/api.js';
import type { AssetOut } from '../types/index.js';

interface ModelViewerProps {
  asset: AssetOut;
  onClose: () => void;
}

const STL_EXTS = new Set(['.stl', '.obj', '.3mf']);
const SVG_EXTS = new Set(['.svg']);
const DXF_EXTS = new Set(['.dxf']);
const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);

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

export function ModelViewer({ asset, onClose }: ModelViewerProps) {
  const ext = getExt(asset.filename);

  return (
    <Modal
      title={asset.originalName || asset.filename}
      onClose={onClose}
      wide
    >
      <div className="h-[75vh]">
        {STL_EXTS.has(ext) && <ThreeViewer asset={asset} />}
        {(SVG_EXTS.has(ext) || DXF_EXTS.has(ext)) && <SvgViewer asset={asset} />}
        {IMG_EXTS.has(ext) && <ImageViewer asset={asset} />}
        {!STL_EXTS.has(ext) && !SVG_EXTS.has(ext) && !DXF_EXTS.has(ext) && !IMG_EXTS.has(ext) && (
          <div className="flex items-center justify-center h-full text-gray-500">
            No preview available for this file type
          </div>
        )}
      </div>
    </Modal>
  );
}
