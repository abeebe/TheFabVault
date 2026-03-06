import { useState } from 'react';

interface StarRatingProps {
  rating: number | null;          // current rating (1–5) or null
  onChange?: (rating: number | null) => void; // undefined = read-only
  size?: 'sm' | 'md';
}

const LABELS = ['Terrible', 'Poor', 'OK', 'Good', 'Great'];

export function StarRating({ rating, onChange, size = 'md' }: StarRatingProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  const active = hovered ?? rating ?? 0;
  const isReadOnly = !onChange;

  const starSize = size === 'sm' ? 'text-sm' : 'text-base';
  const gapClass = size === 'sm' ? 'gap-0.5' : 'gap-1';

  function handleClick(star: number) {
    if (!onChange) return;
    // Clicking the current rating clears it
    onChange(star === rating ? null : star);
  }

  return (
    <div
      className={`flex items-center ${gapClass}`}
      onMouseLeave={() => setHovered(null)}
      title={active > 0 ? LABELS[active - 1] : 'Unrated'}
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          disabled={isReadOnly}
          onClick={() => handleClick(star)}
          onMouseEnter={() => !isReadOnly && setHovered(star)}
          className={`leading-none transition-colors ${starSize} ${
            isReadOnly ? 'cursor-default' : 'cursor-pointer hover:scale-110'
          } ${
            star <= active
              ? 'text-amber-400'
              : 'text-gray-300 dark:text-gray-600'
          }`}
          aria-label={`Rate ${star} star${star !== 1 ? 's' : ''}`}
        >
          ★
        </button>
      ))}
    </div>
  );
}
