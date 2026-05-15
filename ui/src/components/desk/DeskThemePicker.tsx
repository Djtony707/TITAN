/**
 * Desk Theme Picker
 *
 * Compact theme chooser for TITAN's desk aesthetic.
 * Reads / writes the active theme from localStorage under `titan-desk-theme`.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { DeskTheme } from './DeskSurface';

const THEMES: Array<{ id: DeskTheme; label: string; swatch: string }> = [
  { id: 'oak',      label: 'Oak',      swatch: 'linear-gradient(135deg, #6e4724, #482a13)' },
  { id: 'walnut',   label: 'Walnut',   swatch: 'linear-gradient(135deg, #4a2e18, #2a1808)' },
  { id: 'mahogany', label: 'Mahogany', swatch: 'linear-gradient(135deg, #5e2a1a, #38160c)' },
  { id: 'white',    label: 'White',    swatch: 'linear-gradient(135deg, #f4f1ea, #ddd9ce)' },
];

const STORAGE_KEY = 'titan-desk-theme';

function readStored(): DeskTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'oak' || raw === 'walnut' || raw === 'mahogany' || raw === 'white') return raw;
  } catch { /* ignore */ }
  return 'oak';
}

function writeStored(t: DeskTheme) {
  try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
}

export function DeskThemePicker({ className }: { className?: string }) {
  const [theme, setThemeState] = useState<DeskTheme>(readStored);

  useEffect(() => {
    // Listen for theme changes from other tabs/components
    const handler = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        const t = e.newValue as DeskTheme;
        if (THEMES.some(x => x.id === t)) setThemeState(t);
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);

  const setTheme = useCallback((t: DeskTheme) => {
    setThemeState(t);
    writeStored(t);
    window.dispatchEvent(new CustomEvent('desk-theme', { detail: t }));
  }, []);

  return (
    <div className={`flex items-center gap-2 ${className ?? ''}`}>
      <span className="text-[10px] uppercase tracking-widest text-[#a89070]">Desk</span>
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setTheme(t.id)}
          title={t.label}
          className={`w-5 h-5 rounded-full border-2 transition-transform hover:scale-110 ${
            theme === t.id ? 'border-[#c4a35a] scale-110' : 'border-transparent'
          }`}
          style={{ background: t.swatch }}
        />
      ))}
    </div>
  );
}

export default DeskThemePicker;
