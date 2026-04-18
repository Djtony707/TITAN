/**
 * TITAN — Organism Canvas (v4.5.0)
 *
 * Canvas 2D renderer for the 5-drive organism. Each drive is a soft,
 * breathing organelle whose pulse rate + size are driven by its
 * satisfaction vs setpoint. Hormone particles drift from pressed
 * organelles toward the central "core". A gentle heartbeat ripple
 * every ~20s ties the whole scene together.
 *
 * This is the pragmatic v4.5.0 version. v4.5.1 upgrades to a WebGL
 * metaball fragment shader for true fluid edges (see v4.3 roadmap).
 * Canvas 2D is beautiful enough to ship and has zero bundle impact.
 */
import { useEffect, useRef } from 'react';
import type { WatchDrive } from './types';
import { driveColor } from './types';

interface Props {
    drives: WatchDrive[];
    /** Multiplier on particle emission & breath intensity when recent activity */
    excited?: boolean;
    /** Respect prefers-reduced-motion */
    reducedMotion?: boolean;
}

function hexToRgba(hex: string, a: number): string {
    const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
    if (!m) return `rgba(160, 160, 160, ${a})`;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${a})`;
}

export function OrganismCanvas({ drives, excited = false, reducedMotion = false }: Props) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const drivesRef = useRef(drives);
    const excitedRef = useRef(excited);
    const rafRef = useRef<number | null>(null);

    // Keep refs current without restarting the RAF loop
    useEffect(() => { drivesRef.current = drives; }, [drives]);
    useEffect(() => { excitedRef.current = excited; }, [excited]);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) return;

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            canvas.width = Math.max(2, rect.width * dpr);
            canvas.height = Math.max(2, rect.height * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();
        const resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(canvas);

        // Particle pool for hormone flow (capped, GC-friendly)
        interface Particle {
            sourceIdx: number;
            phase: number; // 0..1 (0 = source, 1 = core)
            color: string;
            size: number;
        }
        const particles: Particle[] = [];
        const MAX_PARTICLES = 60;

        let frame = 0;
        const render = () => {
            rafRef.current = requestAnimationFrame(render);
            frame += 1;
            const rect = canvas.getBoundingClientRect();
            const W = rect.width;
            const H = rect.height;
            if (W < 10 || H < 10) return;

            const cx = W / 2;
            const cy = H / 2;
            const baseRadius = Math.min(W, H) * 0.11;
            const orbitR = Math.min(W, H) * 0.34;
            const t = performance.now() / 1000;
            const d = drivesRef.current;

            ctx.clearRect(0, 0, W, H);

            // ── Central core glow (whole-organism ambient hormone)
            const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(W, H) * 0.55);
            const coreIntensity = reducedMotion ? 0.08 : 0.08 + 0.03 * Math.sin(t * 0.5);
            coreGrad.addColorStop(0, `rgba(255, 255, 255, ${coreIntensity * 2})`);
            coreGrad.addColorStop(0.3, `rgba(167, 139, 250, ${coreIntensity})`);
            coreGrad.addColorStop(1, 'rgba(167, 139, 250, 0)');
            ctx.fillStyle = coreGrad;
            ctx.fillRect(0, 0, W, H);

            // ── Organelles
            const N = Math.max(d.length, 5);
            for (let i = 0; i < d.length; i++) {
                const drive = d[i];
                const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
                const ox = cx + Math.cos(angle) * orbitR;
                const oy = cy + Math.sin(angle) * orbitR;

                // Pressure modulates both pulse speed and amplitude
                const pressureMod = Math.min(1, (drive.pressure || 0) * 3);
                const breathSpeed = reducedMotion ? 0 : 0.35 + pressureMod * 1.4;
                const pulseAmp = reducedMotion ? 0 : 0.04 + pressureMod * 0.15;
                const radius = baseRadius * (0.75 + pulseAmp * Math.sin(t * breathSpeed + i * 1.3));

                const color = driveColor(drive.id);

                // Outer halo
                const haloR = radius * 2.8;
                const haloGrad = ctx.createRadialGradient(ox, oy, 0, ox, oy, haloR);
                haloGrad.addColorStop(0, hexToRgba(color, 0.35));
                haloGrad.addColorStop(0.35, hexToRgba(color, 0.18));
                haloGrad.addColorStop(1, hexToRgba(color, 0));
                ctx.fillStyle = haloGrad;
                ctx.beginPath();
                ctx.arc(ox, oy, haloR, 0, Math.PI * 2);
                ctx.fill();

                // Core organelle — soft disc with offset highlight for depth
                const discGrad = ctx.createRadialGradient(
                    ox - radius * 0.3, oy - radius * 0.3, 0,
                    ox, oy, radius,
                );
                discGrad.addColorStop(0, hexToRgba(color, 0.95));
                discGrad.addColorStop(0.55, hexToRgba(color, 0.55));
                discGrad.addColorStop(1, hexToRgba(color, 0.2));
                ctx.fillStyle = discGrad;
                ctx.beginPath();
                ctx.arc(ox, oy, radius, 0, Math.PI * 2);
                ctx.fill();

                // Pressure ring — bright outline when pressure is active
                if (pressureMod > 0.1) {
                    ctx.strokeStyle = hexToRgba(color, 0.6 + 0.3 * Math.sin(t * 3 + i));
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(ox, oy, radius * 1.05, 0, Math.PI * 2);
                    ctx.stroke();
                }

                // Drive label
                ctx.font = '600 10px -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillStyle = 'rgba(255,255,255,0.65)';
                ctx.fillText(drive.label.toUpperCase(), ox, oy + radius + 18);

                // Satisfaction readout
                ctx.font = '11px -apple-system, system-ui';
                ctx.fillStyle = 'rgba(255,255,255,0.35)';
                ctx.fillText(
                    `${Math.round((drive.satisfaction || 0) * 100)}%`,
                    ox, oy + radius + 32,
                );

                // Emit a hormone particle occasionally when pressure is real
                const emitChance = pressureMod * 0.25 + (excitedRef.current ? 0.03 : 0);
                if (!reducedMotion && particles.length < MAX_PARTICLES && Math.random() < emitChance) {
                    particles.push({
                        sourceIdx: i,
                        phase: 0,
                        color,
                        size: 2 + Math.random() * 2,
                    });
                }
            }

            // ── Hormone particles
            if (!reducedMotion) {
                for (let p = particles.length - 1; p >= 0; p--) {
                    const part = particles[p];
                    part.phase += 0.012;
                    if (part.phase >= 1) { particles.splice(p, 1); continue; }
                    const drive = d[part.sourceIdx];
                    if (!drive) { particles.splice(p, 1); continue; }
                    const angle = (part.sourceIdx / N) * Math.PI * 2 - Math.PI / 2;
                    const ox = cx + Math.cos(angle) * orbitR;
                    const oy = cy + Math.sin(angle) * orbitR;
                    // Bezier curve (source -> gentle arc -> core)
                    const midX = (ox + cx) / 2 + Math.sin(angle + Math.PI / 2) * 20;
                    const midY = (oy + cy) / 2 + Math.cos(angle + Math.PI / 2) * 20;
                    const px = (1 - part.phase) * (1 - part.phase) * ox + 2 * (1 - part.phase) * part.phase * midX + part.phase * part.phase * cx;
                    const py = (1 - part.phase) * (1 - part.phase) * oy + 2 * (1 - part.phase) * part.phase * midY + part.phase * part.phase * cy;
                    const alpha = Math.sin(part.phase * Math.PI) * 0.9;
                    ctx.fillStyle = hexToRgba(part.color, alpha);
                    ctx.beginPath();
                    ctx.arc(px, py, part.size, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // ── Heartbeat ripple (once every ~20s)
            if (!reducedMotion) {
                const heartPeriod = 20;
                const heartPhase = (t % heartPeriod) / heartPeriod;
                if (heartPhase < 0.18) {
                    const ringR = baseRadius + heartPhase * Math.min(W, H) * 2.5;
                    const op = (1 - heartPhase / 0.18) * 0.18;
                    ctx.strokeStyle = `rgba(167, 139, 250, ${op})`;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
                    ctx.stroke();
                }
            }
        };

        rafRef.current = requestAnimationFrame(render);

        return () => {
            resizeObserver.disconnect();
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [reducedMotion]);

    return (
        <canvas
            ref={canvasRef}
            style={{ width: '100%', height: '100%', display: 'block' }}
            aria-label="TITAN organism — 5 drives breathing"
        />
    );
}
