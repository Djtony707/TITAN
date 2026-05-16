/**
 * Observatory Surface — Phase 0c (v6.1.0-beta.3)
 *
 * Sibling to DeskSurface. Renders the Observatory aesthetic:
 *   - deep indigo base (#1a1235 → #0e0820 gradient)
 *   - faint starfield (~8 fixed dots via stacked radial-gradient layers,
 *     matching the mockup's body::before so positions stay stable across
 *     renders and theme switches)
 *   - vignette + soft top glow
 *
 * Props mirror DeskSurface so the ThemedSurface switcher in DeskSurface.tsx
 * can swap in this component with zero call-site change. Stars are NOT
 * suppressible — they're part of the aesthetic, not a "dust mote" layer.
 * `noMotes` is honored as a no-op so the prop surface stays identical.
 *
 * Aesthetic verified against ~/Desktop/titan-ops-mockup.html
 * (:root[data-theme="observatory"] palette + body::before starfield).
 */
import React from 'react';

interface Props {
    /** Accepted for API parity with DeskSurface; ignored here. */
    noMotes?: boolean;
    className?: string;
    children: React.ReactNode;
}

const BG_TOP = '#1a1235';
const BG_BOTTOM = '#0e0820';
const GLOW = 'rgba(140,160,255,0.10)';
const VIGNETTE = 'rgba(0,0,0,0.70)';

export function ObservatorySurface({ className, children }: Props) {
    const surfaceStyle: React.CSSProperties = {
        background: [
            `radial-gradient(ellipse 80% 60% at 20% 0%, ${GLOW} 0%, transparent 55%)`,
            `linear-gradient(180deg, ${BG_TOP} 0%, ${BG_BOTTOM} 100%)`,
        ].join(','),
        color: '#e8e8ff',
    };

    // Starfield — 8 radial-gradient layers at fixed coords, copied from
    // the mockup. Stacking them in one element means the GPU rasterizes
    // once; positions stay stable across renders (no React-driven jitter).
    const starsStyle: React.CSSProperties = {
        background: [
            'radial-gradient(2px 2px at 13% 22%, #fff 50%, transparent 51%)',
            'radial-gradient(1.5px 1.5px at 67% 44%, #cce 50%, transparent 51%)',
            'radial-gradient(1px 1px at 85% 18%, #fff 50%, transparent 51%)',
            'radial-gradient(2px 2px at 30% 80%, #fff 50%, transparent 51%)',
            'radial-gradient(1px 1px at 90% 70%, #cce 50%, transparent 51%)',
            'radial-gradient(1.5px 1.5px at 50% 60%, #fff 50%, transparent 51%)',
            'radial-gradient(1px 1px at 22% 50%, #fff 50%, transparent 51%)',
            'radial-gradient(1.5px 1.5px at 75% 90%, #ace 50%, transparent 51%)',
        ].join(','),
        opacity: 0.6,
        animation: 'observatoryTwinkle 8s ease-in-out infinite',
    };

    const vignetteStyle: React.CSSProperties = {
        background: `radial-gradient(ellipse at 50% 50%, transparent 50%, ${VIGNETTE} 100%)`,
    };

    return (
        <div className={`fixed inset-0 overflow-hidden font-sans ${className ?? ''}`} style={surfaceStyle}>
            {/* Starfield */}
            <div className="pointer-events-none absolute inset-0" style={starsStyle} />
            {/* Vignette */}
            <div className="pointer-events-none absolute inset-0" style={vignetteStyle} />

            <style>{KEYFRAMES}</style>

            {/* Content layer */}
            <div className="relative z-10 w-full h-full">{children}</div>
        </div>
    );
}

ObservatorySurface.displayName = 'ObservatorySurface';

const KEYFRAMES = `
@keyframes observatoryTwinkle {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 0.75; }
}
`;

export default ObservatorySurface;
