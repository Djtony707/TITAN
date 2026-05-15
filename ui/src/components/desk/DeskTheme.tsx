/**
 * Desk Theme Context
 *
 * Provides the current desk theme (oak/walnut/mahogany/white) as a
 * React context so any descendant can react to theme changes without
 * prop-drilling. Persists the user's preference to localStorage under
 * `titan-desk-theme`.
 *
 * Usage:
 *
 *   import { DeskThemeProvider, useDeskTheme } from '@/components/desk/DeskTheme';
 *
 *   // At a high level (App or DeskSurface wrapper):
 *   <DeskThemeProvider>
 *     <DeskSurface>{children}</DeskSurface>
 *   </DeskThemeProvider>
 *
 *   // Anywhere deeper:
 *   const { theme, setTheme } = useDeskTheme();
 *
 *   // Switch theme:
 *   <button onClick={() => setTheme('walnut')}>Walnut</button>
 */
import React, { createContext, useCallback, useContext, useState, useEffect } from 'react';
import type { DeskTheme } from './DeskSurface';

interface DeskThemeCtx {
  theme: DeskTheme;
  setTheme: (t: DeskTheme) => void;
}

const STORAGE_KEY = 'titan-desk-theme';

export const DeskThemeContext = createContext<DeskThemeCtx | null>(null);

export function DeskThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<DeskTheme>('oak');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === 'oak' || raw === 'walnut' || raw === 'mahogany' || raw === 'white') {
        setThemeState(raw);
      }
    } catch { /* ignore — localStorage may be blocked in iframes */ }
  }, []);

  const setTheme = useCallback((t: DeskTheme) => {
    setThemeState(t);
    try { localStorage.setItem(STORAGE_KEY, t); } catch { /* ignore */ }
  }, []);

  return (
    <DeskThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </DeskThemeContext.Provider>
  );
}

export function useDeskTheme(): DeskThemeCtx {
  const ctx = useContext(DeskThemeContext);
  if (!ctx) throw new Error('useDeskTheme must be used inside a DeskThemeProvider');
  return ctx;
}
