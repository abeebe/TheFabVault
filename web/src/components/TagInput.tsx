import { useState, KeyboardEvent } from 'react';
import { X } from 'lucide-react';

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

const TAG_COLORS = [
  'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  'bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-200',
  'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
];

export function tagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = (hash * 31 + tag.charCodeAt(i)) % TAG_COLORS.length;
  }
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function TagBadge({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${tagColor(tag)}`}>
      {tag}
      {onRemove && (
        <button onClick={onRemove} className="hover:opacity-70 transition-opacity">
          <X size={10} />
        </button>
      )}
    </span>
  );
}

export function TagInput({ tags, onChange, placeholder = 'Add tag, press Enter or comma' }: TagInputProps) {
  const [input, setInput] = useState('');

  function addTag(raw: string): void {
    const trimmed = raw.trim();
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput('');
  }

  function handleKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
    } else if (e.key === 'Backspace' && !input && tags.length) {
      onChange(tags.slice(0, -1));
    }
  }

  function handleChange(val: string): void {
    if (val.includes(',')) {
      const parts = val.split(',');
      parts.slice(0, -1).forEach((p) => addTag(p));
      setInput(parts[parts.length - 1]);
    } else {
      setInput(val);
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5 items-center min-h-[36px] px-2 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 focus-within:ring-2 focus-within:ring-accent/50">
      {tags.map((tag) => (
        <TagBadge key={tag} tag={tag} onRemove={() => onChange(tags.filter((t) => t !== tag))} />
      ))}
      <input
        type="text"
        value={input}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => { if (input.trim()) addTag(input); }}
        placeholder={tags.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[120px] bg-transparent outline-none text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400"
      />
    </div>
  );
}
