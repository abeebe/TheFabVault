import { useSyncExternalStore } from 'react';
import { subscribe, getSnapshot } from '../lib/importStore.js';

export function useImportJob() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
