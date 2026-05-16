/**
 * Workshop Surface — Phase 0c (v6.1.0-beta.3)
 *
 * Sibling to DeskSurface. Renders the Workshop aesthetic:
 *   - brushed steel base (slate-blue gradient)
 *   - faint blueprint grid overlay (1px lines, 32px squares, blue ~6% opacity)
 *   - window-glow + vignette layers (kept consistent with DeskSurface so
 *     children that lean on the "depth" feel still look right)
 *
 * Props mirror DeskSurface so the ThemedSurface switcher in DeskSurface.tsx
 * can swap between them at runtime with zero call-site change. We
 * intentionally don't read DeskTheme here — Workshop has no wood variants.
 *
 * Aesthetic verified against ~/Desktop/titan-ops-mockup.html (workshop
 * palette + body::before grid).
 */
import React from 'react';

interface Props {
    /** If true, suppresses the floating spec-particles layer. */
    noMotes?: boolean;
    className?: string;
    children: React.ReactNode;
}

// Palette pulled from the mockup's :root[data-theme="workshop"] block so
// the BACKGROUND visibly matches the CSS-variable palette CSS consumers
// already see. Mockup uses #1a2030 → #141925 (slate-blue, not pure steel).
const BG_BASE = '#1a2030';
const BG_GRAIN = '#141925';
const GRID_LINE = 'rgba(120,180,255,0.06)';
const GLOW = 'rgba(180,210,255,0.10)';
const VIGNETTE = 'rgba(0,0,0,0.60)';
const PARTICLE_COLOR = 'rgba(190,210,235,0.35)';

export function WorkshopSurface({ noMotes, className, children }: Props) {
    // Brushed-steel base: subtle 95° striping (mimics the mockup's body
    // gradient) layered under a soft top-left light source.
    const surfaceStyle: React.CSSProperties = {
        background: [
            `radial-gradient(ellipse 80% 60% at 20% 0%, ${GLOW} 0%, transparent 55%)`,
            `repeating-linear-gradient(95deg, ${BG_BASE} 0 14px, ${BG_GRAIN} 14px 28px)`,
        ].join(','),
        color: '#e8eef4',
    };

    // Blueprint grid overlay — 1px lines, 32px squares, faint blue.
    const gridStyle: React.CSSProperties = {
        backgroundImage: [
            `linear-gradient(${GRID_LINE} 1px, transparent 1px)`,
            `linear-gradient(90deg, ${GRID_LINE} 1px, transparent 1px)`,
        ].join(','),
        backgroundSize: '32px 32px, 32px 32px',
    };

    const vignetteStyle: React.CSSProperties = {
        background: `radial-gradient(ellipse at 50% 50%, transparent 50%, ${VIGNETTE} 100%)`,
    };

    return (
        <div className={`fixed inset-0 overflow-hidden font-sans ${className ?? ''}`} style={surfaceStyle}>
            {/* Blueprint grid */}
            <div className="pointer-events-none absolute inset-0" style={gridStyle} />
            {/* Vignette */}
            <div className="pointer-events-none absolute inset-0" style={vignetteStyle} />

            {/* Spec-dust particles (parity with DeskSurface motes, suppressible) */}
            {!noMotes && <WorkshopParticles />}

            <style>{KEYFRAMES}</style>

            {/* Content layer */}
            <div className="relative z-10 w-full h-full">{children}</div>
        </div>
    );
}

// Set displayName so the smoke test can assert it without depending on
// JS function-name minification quirks in production builds.
WorkshopSurface.displayName = 'WorkshopSurface';

// ── Floating particles ───────────────────────────────────────────

function WorkshopParticles() {
    // Deterministic positions (seeded the same way DeskSurface seeds dust
    // motes) so re-renders don't reshuffle the layout.
    const motes = React.useMemo(() => {
        const rng = mulberry32(0x57415348 /* 'WASH' */);
        return Array.from({ length: 18 }, (_, i) => ({
            id: i,
            left: `${(rng() * 100).toFixed(1)}%`,
            top: `${(rng() * 100).toFixed(1)}%`,
            delay: `${(rng() * 12).toFixed(1)}s`,
            duration: `${10 + rng() * 6}s`,
            size: `${1 + rng() * 1.5}px`,
            variant: i % 2 === 0 ? 'workshopMote1' : 'workshopMote2',
        }));
    }, []);

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
                        background: PARTICLE_COLOR,
                        animation: `${m.variant} ${m.duration} linear ${m.delay} infinite`,
                    }}
                />
            ))}
        </div>
    );
}

const KEYFRAMES = `
@keyframes workshopMote1 {
  0%   { transform: translate(0, 0) scale(1); opacity: 0; }
  10%  { opacity: 0.5; }
  90%  { opacity: 0.4; }
  100% { transform: translate(10px, -90vh) scale(1.1); opacity: 0; }
}
@keyframes workshopMote2 {
  0%   { transform: translate(0, 0) scale(0.9); opacity: 0; }
  10%  { opacity: 0.35; }
  90%  { opacity: 0.25; }
  100% { transform: translate(-8px, -90vh) scale(1); opacity: 0; }
}
`;

function mulberry32(a: number) {
    return () => {
        let t = (a += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export default WorkshopSurface;
