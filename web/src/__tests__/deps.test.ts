// Dep-surface smoke tests for the web bundle.
//
// Goal: catch breaking shape changes from upgrades to lucide-react,
// js-sha256, and three before they hit the running app. Render tests
// live separately (see uploadStore.test.ts) — this file is just module
// imports + pure-function calls.

import { describe, expect, it } from 'vitest';
import { sha256 } from 'js-sha256';
import * as Icons from 'lucide-react';
import * as THREE from 'three';

describe('js-sha256', () => {
  it('hashes a string to the canonical SHA-256 hex digest', () => {
    // Known good vector for "hello world".
    expect(sha256('hello world')).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });

  it('produces the same digest via incremental .update() as one-shot', () => {
    const oneShot = sha256('the quick brown fox jumps over the lazy dog');
    const hasher = sha256.create();
    hasher.update('the quick brown ');
    hasher.update('fox jumps over ');
    hasher.update('the lazy dog');
    expect(hasher.hex()).toBe(oneShot);
  });

  it('accepts Uint8Array chunks (matches the file.stream() path in uploadStore)', () => {
    const enc = new TextEncoder();
    const hasher = sha256.create();
    hasher.update(enc.encode('hello '));
    hasher.update(enc.encode('world'));
    expect(hasher.hex()).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });
});

describe('lucide-react', () => {
  // Spot-check icons we actually import across the app. If a future
  // lucide release renames or removes any of these, the import lookup
  // here fails and we catch it before runtime.
  const used = [
    'Upload', 'FolderOpen', 'CheckCircle', 'AlertCircle', 'X', 'Copy',
    'Search', 'Settings', 'Trash2', 'Plus', 'ChevronDown', 'ChevronRight',
    'Folder', 'File', 'FileText', 'Image', 'Heart', 'Tag', 'Hash',
    'LogOut', 'Moon', 'Sun', 'Monitor', 'RefreshCw', 'Download',
    'Layers', 'LayoutGrid', 'History', 'Edit2', 'MoreHorizontal',
  ];

  it.each(used)('exports icon %s', (name) => {
    const icon = (Icons as Record<string, unknown>)[name];
    expect(icon, `lucide-react no longer exports ${name}`).toBeDefined();
    expect(typeof icon === 'function' || typeof icon === 'object').toBe(true);
  });
});

describe('three', () => {
  it('exposes the core constructors we use in viewers', () => {
    // Just confirm the named exports still exist with the right shape.
    expect(typeof THREE.Scene).toBe('function');
    expect(typeof THREE.PerspectiveCamera).toBe('function');
    expect(typeof THREE.WebGLRenderer).toBe('function');
    expect(typeof THREE.Mesh).toBe('function');
    expect(typeof THREE.BufferGeometry).toBe('function');
  });

  it('Vector3 arithmetic still works', () => {
    const v = new THREE.Vector3(1, 2, 3).add(new THREE.Vector3(4, 5, 6));
    expect(v.x).toBe(5);
    expect(v.y).toBe(7);
    expect(v.z).toBe(9);
  });
});
