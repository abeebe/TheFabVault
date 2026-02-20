import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}

export function Modal({ title, onClose, children, wide = false }: ModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div
        className={`relative bg-surface-2 rounded-xl shadow-2xl flex flex-col max-h-[90vh] ${
          wide ? 'w-[90vw] max-w-5xl' : 'w-full max-w-lg mx-4'
        }`}
      >
        {title && (
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="overflow-auto flex-1">{children}</div>
      </div>
    </div>
  );
}
