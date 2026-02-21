import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import type { AssetOut } from '../types/index.js';
import { Spinner } from './Spinner.js';

interface Props {
  asset: AssetOut;
}

// Maximum lines to display (large files can be huge)
const MAX_LINES = 2000;

function tokenizeLine(line: string): React.ReactNode {
  if (!line.trim()) return <span>{'\n'}</span>;

  // Full-line comment
  if (line.trimStart().startsWith(';')) {
    return <span className="text-green-500 dark:text-green-400">{line}</span>;
  }

  // Tokenize commands + coordinates + inline comments
  const parts: React.ReactNode[] = [];
  let remaining = line;
  let key = 0;

  const patterns: [RegExp, string][] = [
    [/^(;.*)/, 'comment'],
    [/^([GM]\d+(?:\.\d+)?)/i, 'command'],
    [/^([XYZEFIJS]-?[\d.]+)/i, 'coord'],
    [/^(\s+)/, 'space'],
    [/^([^\s;GMXYZEFI]+)/i, 'other'],
  ];

  while (remaining.length > 0) {
    let matched = false;
    for (const [re, type] of patterns) {
      const m = remaining.match(re);
      if (m) {
        const text = m[1];
        if (type === 'comment') {
          parts.push(<span key={key++} className="text-green-500 dark:text-green-400">{text}</span>);
        } else if (type === 'command') {
          const isG = text[0].toUpperCase() === 'G';
          parts.push(
            <span key={key++} className={isG ? 'text-blue-500 dark:text-blue-400 font-semibold' : 'text-orange-500 dark:text-orange-400 font-semibold'}>
              {text}
            </span>
          );
        } else if (type === 'coord') {
          parts.push(
            <span key={key++}>
              <span className="text-purple-500 dark:text-purple-400">{text[0]}</span>
              <span className="text-gray-600 dark:text-gray-300">{text.slice(1)}</span>
            </span>
          );
        } else {
          parts.push(<span key={key++} className="text-gray-600 dark:text-gray-300">{text}</span>);
        }
        remaining = remaining.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) {
      parts.push(<span key={key++}>{remaining[0]}</span>);
      remaining = remaining.slice(1);
    }
  }

  return <>{parts}</>;
}

export function GCodeViewer({ asset }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    const url = api.assets.fileUrl(asset);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        const allLines = text.split('\n');
        if (allLines.length > MAX_LINES) {
          setTruncated(true);
          setLines(allLines.slice(0, MAX_LINES));
        } else {
          setLines(allLines);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [asset.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-48 text-sm text-red-500">
        Failed to load file: {error}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {truncated && (
        <div className="px-4 py-1.5 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-700 text-xs text-yellow-700 dark:text-yellow-400">
          Showing first {MAX_LINES.toLocaleString()} lines of {(lines.length + '+ lines').replace(/^\d+/, (lines.length + '').replace(/\B(?=(\d{3})+(?!\d))/g, ','))}.
        </div>
      )}
      <pre className="flex-1 overflow-auto text-xs leading-5 p-4 font-mono bg-gray-50 dark:bg-gray-900 select-text">
        {lines.map((line, i) => (
          <div key={i} className="flex gap-3 hover:bg-gray-100 dark:hover:bg-gray-800/50 px-1 -mx-1 rounded">
            <span className="select-none text-gray-300 dark:text-gray-600 text-right shrink-0" style={{ minWidth: '3rem' }}>
              {i + 1}
            </span>
            <span className="flex-1 whitespace-pre">{tokenizeLine(line)}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
