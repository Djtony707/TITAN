import React from 'react';
import { GLOBAL_SHORTCUTS } from '@/hooks/useKeyboardShortcuts';

export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 max-w-md w-full shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-4">Keyboard Shortcuts</h2>
        <div className="space-y-2">
          {GLOBAL_SHORTCUTS.map((s) => (
            <div key={s.key + s.description} className="flex justify-between text-sm">
              <span className="text-zinc-300">{s.description}</span>
              <kbd className="px-2 py-0.5 bg-zinc-800 rounded text-zinc-400 font-mono text-xs">{s.key}</kbd>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-zinc-500">Press Escape to close</p>
      </div>
    </div>
  );
}
