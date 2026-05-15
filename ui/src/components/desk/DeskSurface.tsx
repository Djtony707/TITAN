/**
 * Desk Surface — Unified Aesthetic Layer for All of TITAN
 *
 * Extracted from MissionCanvas so the warm wood desk can be used
 * as the base for TitanCanvas, Settings pages, and any other view.
 *
 * Features:
 *   - 4 theme variants: oak, walnut, mahogany, white
 *   - wood grain, knots, window-glow, vignette, dust motes
 *   - CSS keyframes for animated glow, motes, tether lines
 *   - children render ON TOP of the surface (z-0 → z-10)
 */
import React from 'react';

export type DeskTheme = 'oak' | 'walnut' | 'mahogany' | 'white';

const DEFAULT_THEME: DeskTheme = 'oak';
const STORAGE_KEY = 'titan-desk-theme';

function readStoredTheme(): DeskTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'oak' || raw === 'walnut' || raw === 'mahogany' || raw === 'white') return raw;
  } catch { /* ignore quota/iframe errors */ }
  return DEFAULT_THEME;
}

interface Props {
  /** Overrides the persisted theme for this mount. If omitted, reads from localStorage. */
  theme?: DeskTheme;
  /** If true, suppresses the dust-mote layer */
  noMotes?: boolean;
  className?: string;
  children: React.ReactNode;
}

// ── Theme definitions ──────────────────────────────────────────────

const THEMES: Record<DeskTheme, ThemeAssets> = {
  oak: {
    base: ['#6e4724', '#5a3717', '#482a13'],
    knot: 'rgba(40,18,8,0.55)',
    knot2: 'rgba(40,18,8,0.45)',
    grainLight: 'rgba(255,180,90,0.05)',
    grainDark: 'rgba(60,30,10,0.10)',
    glow: 'rgba(255,220,140,0.18)',
    vignette: 'rgba(0,0,0,0.45)',
    text: '#f3e9d0',
    accent: '#f3d27a',
    border: '#8a6a3a',
    paper: '#f7f5ee',
  },
  walnut: {
    base: ['#4a2e18', '#3a2210', '#2a1808'],
    knot: 'rgba(20,10,4,0.65)',
    knot2: 'rgba(20,10,4,0.50)',
    grainLight: 'rgba(180,140,80,0.04)',
    grainDark: 'rgba(40,20,8,0.14)',
    glow: 'rgba(210,170,100,0.14)',
    vignette: 'rgba(0,0,0,0.55)',
    text: '#e8dcc8',
    accent: '#d4b06a',
    border: '#6e5030',
    paper: '#f0ebe0',
  },
  mahogany: {
    base: ['#5e2a1a', '#4a1f12', '#38160c'],
    knot: 'rgba(30,8,4,0.60)',
    knot2: 'rgba(30,8,4,0.50)',
    grainLight: 'rgba(200,120,80,0.04)',
    grainDark: 'rgba(60,20,10,0.12)',
    glow: 'rgba(230,160,110,0.15)',
    vignette: 'rgba(0,0,0,0.50)',
    text: '#f0d8c8',
    accent: '#e8a87c',
    border: '#8a5030',
    paper: '#f5ebe4',
  },
  white: {
    base: ['#f4f1ea', '#e8e4db', '#ddd9ce'],
    knot: 'rgba(160,150,130,0.25)',
    knot2: 'rgba(160,150,130,0.15)',
    grainLight: 'rgba(200,190,170,0.12)',
    grainDark: 'rgba(140,130,110,0.10)',
    glow: 'rgba(255,255,255,0.30)',
    vignette: 'rgba(0,0,0,0.08)',
    text: '#2a2825',
    accent: '#8a7a5a',
    border: '#b8b0a0',
    paper: '#ffffff',
  },
};

interface ThemeAssets {
  base: [string, string, string];
  knot: string;
  knot2: string;
  grainLight: string;
  grainDark: string;
  glow: string;
  vignette: string;
  text: string;
  accent: string;
  border: string;
  paper: string;
}

// ── Component ────────────────────────────────────────────────────

export function DeskSurface({ theme: propTheme, noMotes, className, children }: Props) {
  const t = THEMES[propTheme ?? readStoredTheme()];

  const deskStyle: React.CSSProperties = {
    background: [
      // Knot near upper-right
      `radial-gradient(ellipse 120px 80px at 78% 28%, ${t.knot} 0%, transparent 70%)`,
      // Knot near lower-left
      `radial-gradient(ellipse 90px 60px at 22% 72%, ${t.knot2} 0%, transparent 75%)`,
      // Primary grain
      `repeating-linear-gradient(92deg, ${t.grainLight} 0px, ${t.grainDark} 3px, ${t.grainLight} 7px, ${t.grainDark} 11px, ${t.grainLight} 16px)`,
      // Cross grain
      `repeating-linear-gradient(0deg, rgba(0,0,0,0.04) 0px, transparent 2px, rgba(0,0,0,0.03) 4px)`,
      // Base colour
      `linear-gradient(180deg, ${t.base[0]} 0%, ${t.base[1]} 50%, ${t.base[2]} 100%)`,
    ].join(','),
    color: t.text,
  };

  const glowStyle: React.CSSProperties = {
    background: `radial-gradient(ellipse 80% 60% at 20% 0%, ${t.glow} 0%, transparent 55%)`,
  };

  const vignetteStyle: React.CSSProperties = {
    background: `radial-gradient(ellipse at 50% 50%, transparent 50%, ${t.vignette} 100%)`,
  };

  return (
    <div className={`fixed inset-0 overflow-hidden font-sans ${className ?? ''}`} style={deskStyle}>
      {/* Window-light glow */}
      <div className="pointer-events-none absolute inset-0" style={glowStyle} />
      {/* Vignette */}
      <div className="pointer-events-none absolute inset-0" style={vignetteStyle} />

      {/* Dust motes */}
      {!noMotes && <DustMotes theme={propTheme ?? readStoredTheme()} />}

      {/* CSS keyframes */}
      <style>{KEYFRAMES}</style>

      {/* Content layer */}
      <div className="relative z-10 w-full h-full">{children}</div>
    </div>
  );
}

// ── Dust Motes ───────────────────────────────────────────────────

function DustMotes({ theme }: { theme: DeskTheme }) {
  // Generate deterministic pseudo-random positions from theme name
  // so motes don't jump on every re-render.
  const motes = React.useMemo(() => {
    const seed = theme.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const rng = mulberry32(seed);
    return Array.from({ length: 24 }, (_, i) => ({
      id: i,
      left: `${(rng() * 100).toFixed(1)}%`,
      top: `${(rng() * 100).toFixed(1)}%`,
      delay: `${(rng() * 12).toFixed(1)}s`,
      duration: `${8 + rng() * 6}s`,
      size: `${1 + rng() * 2}px`,
      variant: i % 2 === 0 ? 'mote1' : 'mote2',
      color: theme === 'white' ? 'rgba(180,170,150,0.5)' : 'rgba(245,235,210,0.45)',
    }));
  }, [theme]);

  return (
    <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
      {motes.map(m => (
        <div
          key={m.id}
          className="absolute rounded-full"
          style={{
            left: m.left,
            top: m.top,
            width: m.size,
            height: m.size,
            background: m.color,
            animation: `${m.variant} ${m.duration} linear ${m.delay} infinite`,
          }}
        />
      ))}
    </div>
  );
}

// ── Keyframes ────────────────────────────────────────────────────

const KEYFRAMES = `
@keyframes deskGlow {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 0.8; }
}
@keyframes mote1 {
  0%   { transform: translate(0, 0) scale(1); opacity: 0; }
  10%  { opacity: 0.55; }
  90%  { opacity: 0.45; }
  100% { transform: translate(14px, -90vh) scale(1.1); opacity: 0; }
}
@keyframes mote2 {
  0%   { transform: translate(0, 0) scale(0.9); opacity: 0; }
  10%  { opacity: 0.4; }
  90%  { opacity: 0.3; }
  100% { transform: translate(-12px, -90vh) scale(1); opacity: 0; }
}
`;

// ── Helpers ────────────────────────────────────────────────────────

function mulberry32(a: number) {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default DeskSurface;
