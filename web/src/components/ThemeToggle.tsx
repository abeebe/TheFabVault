import { Sun, Moon, Monitor } from 'lucide-react';
import type { Theme } from '../types/index.js';

interface ThemeToggleProps {
  theme: Theme;
  onCycle: () => void;
}

const icons: Record<Theme, React.ReactNode> = {
  light: <Sun size={18} />,
  dark: <Moon size={18} />,
  system: <Monitor size={18} />,
};

const labels: Record<Theme, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function ThemeToggle({ theme, onCycle }: ThemeToggleProps) {
  return (
    <button
      onClick={onCycle}
      title={`Theme: ${labels[theme]} (click to cycle)`}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
    >
      {icons[theme]}
      <span className="hidden sm:inline text-xs">{labels[theme]}</span>
    </button>
  );
}
