import { useState, useEffect } from 'react';
import { getStoredTheme, setStoredTheme, applyTheme, watchSystemTheme } from '../lib/theme.js';
import type { Theme } from '../types/index.js';

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== 'system') return;
    return watchSystemTheme(() => applyTheme('system'));
  }, [theme]);

  function setTheme(t: Theme): void {
    setStoredTheme(t);
    setThemeState(t);
    applyTheme(t);
  }

  function cycleTheme(): void {
    const order: Theme[] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
  }

  return { theme, setTheme, cycleTheme };
}
