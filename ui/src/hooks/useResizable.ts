import { useState, useCallback, useRef, useEffect } from 'react';

interface UseResizableOptions {
  direction: 'horizontal' | 'vertical';
  initialSize: number;    // percentage (0-100)
  minSize?: number;       // percentage
  maxSize?: number;       // percentage
  storageKey?: string;    // localStorage key for persistence
}

export function useResizable(options: UseResizableOptions) {
  const { direction, initialSize, minSize = 20, maxSize = 80, storageKey } = options;

  const [size, setSize] = useState(() => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey);
      if (stored) return parseFloat(stored);
    }
    return initialSize;
  });

  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const handleMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pos = direction === 'horizontal'
        ? ((e.clientX - rect.left) / rect.width) * 100
        : ((e.clientY - rect.top) / rect.height) * 100;
      const clamped = Math.min(maxSize, Math.max(minSize, pos));
      setSize(clamped);
      if (storageKey) localStorage.setItem(storageKey, String(clamped));
    };

    const handleUp = () => setIsResizing(false);

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isResizing, direction, minSize, maxSize, storageKey]);

  return { size, isResizing, startResize, containerRef };
}
