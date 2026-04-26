import { useEffect, useCallback } from 'react';

interface Shortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: () => void;
  description: string;
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]) {
  const handler = useCallback((e: KeyboardEvent) => {
    // Ignore when typing in inputs/textareas
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

    for (const s of shortcuts) {
      const keyMatch = e.key.toLowerCase() === s.key.toLowerCase();
      const ctrlMatch = !!s.ctrl === (e.ctrlKey || e.metaKey);
      const shiftMatch = !!s.shift === e.shiftKey;
      const altMatch = !!s.alt === e.altKey;
      if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
        e.preventDefault();
        s.action();
        return;
      }
    }
  }, [shortcuts]);

  useEffect(() => {
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handler]);
}

export const GLOBAL_SHORTCUTS = [
  { key: '?', description: 'Show keyboard shortcuts help' },
  { key: 'g', shift: true, description: 'Go to Command Post space' },
  { key: 'h', shift: true, description: 'Go to Home space' },
  { key: 's', shift: true, description: 'Go to Settings space' },
  { key: 'i', shift: true, description: 'Go to Intelligence space' },
  { key: 'c', ctrl: true, description: 'Focus chat input' },
  { key: 'k', ctrl: true, description: 'Toggle command palette' },
  { key: 'j', ctrl: true, description: 'Toggle chat dock' },
  { key: 'Escape', description: 'Close modals / panels' },
];
