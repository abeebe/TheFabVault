import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '../lib/uploadStore.js';

export function useUploads() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
