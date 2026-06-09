/**
 * Studio Surface — v7.0 "clean professional" theme.
 *
 * Sibling to DeskSurface / WorkshopSurface / ObservatorySurface. Renders the
 * Studio aesthetic: a calm graphite canvas with a barely-there dot grid and a
 * soft top light — deliberately low-chrome (no wood grain, no starfield, no
 * floating particles) so dense admin screens read cleanly. Palette matches the
 * `:root[data-theme='studio']` block in ../../styles/theme-variables.css and is
 * verified ≥ WCAG AA by tests/theme-contrast.test.ts.
 *
 * Props mirror DeskSurface so the ThemedSurface switcher swaps it in with zero
 * call-site change.
 */
import React from 'react';

interface Props {
    /** Accepted for API parity with the other surfaces; Studio has no motes. */
    noMotes?: boolean;
    className?: string;
    children: React.ReactNode;
}

const BG_BASE = '#15171c';
const BG_GRAIN = '#101216';
const DOT = 'rgba(255,255,255,0.035)';
const GLOW = 'rgba(120,160,255,0.06)';
const VIGNETTE = 'rgba(0,0,0,0.5)';

export function StudioSurface({ className, children }: Props) {
    // Graphite base with a soft cool light at top-center.
    const surfaceStyle: React.CSSProperties = {
        background: [
            `radial-gradient(ellipse 90% 55% at 50% -5%, ${GLOW} 0%, transparent 60%)`,
            `linear-gradient(180deg, ${BG_BASE} 0%, ${BG_GRAIN} 100%)`,
        ].join(','),
        color: '#e7e9ee',
    };

    // Faint dot grid — 24px lattice, single-pixel dots at very low opacity.
    const gridStyle: React.CSSProperties = {
        backgroundImage: `radial-gradient(${DOT} 1px, transparent 1px)`,
        backgroundSize: '24px 24px',
    };

    const vignetteStyle: React.CSSProperties = {
        background: `radial-gradient(ellipse at 50% 45%, transparent 55%, ${VIGNETTE} 100%)`,
    };

    return (
        <div className={`fixed inset-0 overflow-hidden font-sans ${className ?? ''}`} style={surfaceStyle}>
            <div className="pointer-events-none absolute inset-0" style={gridStyle} />
            <div className="pointer-events-none absolute inset-0" style={vignetteStyle} />
            <div className="relative z-10 w-full h-full">{children}</div>
        </div>
    );
}

StudioSurface.displayName = 'StudioSurface';
