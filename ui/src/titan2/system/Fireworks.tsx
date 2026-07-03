/**
 * Fireworks — TITAN's celebration layer (v7.0 "Independence").
 *
 * A lightweight canvas particle show. Fires when:
 *   - anything dispatches `titan:fireworks` (big wins: welcome-mode connect,
 *     mascot celebrations on special days)
 *   - it's July 4th (local time): one show on desk load, once per session.
 *
 * Self-contained, ~zero cost when idle: the canvas mounts only for the
 * duration of a show and unmounts after. Respects prefers-reduced-motion.
 */
import { useEffect, useRef, useState } from 'react';

const SHOW_MS = 5200;
const COLORS = ['#ff5a5f', '#ffd166', '#f8f9fa', '#6ec1ff', '#b48cff', '#7ce38b'];

interface Particle {
    x: number; y: number; vx: number; vy: number;
    life: number; maxLife: number; color: string; size: number;
}

function isJulyFourth(): boolean {
    const now = new Date();
    return now.getMonth() === 6 && now.getDate() === 4;
}

export function Fireworks() {
    const [active, setActive] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const stopRef = useRef<number>(0);

    useEffect(() => {
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const launch = () => {
            if (reduced) return;
            stopRef.current = Date.now() + SHOW_MS;
            setActive(true);
        };
        const onEvent = () => launch();
        window.addEventListener('titan:fireworks', onEvent);
        if (isJulyFourth() && !sessionStorage.getItem('titan-fireworks-jul4')) {
            sessionStorage.setItem('titan-fireworks-jul4', '1');
            setTimeout(launch, 2500);
        }
        return () => window.removeEventListener('titan:fireworks', onEvent);
    }, []);

    useEffect(() => {
        if (!active) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const particles: Particle[] = [];
        let raf = 0;
        let lastBurst = 0;

        const burst = () => {
            const cx = canvas.width * (0.2 + Math.random() * 0.6);
            const cy = canvas.height * (0.15 + Math.random() * 0.4);
            const color = COLORS[Math.floor(Math.random() * COLORS.length)];
            const count = 42 + Math.floor(Math.random() * 30);
            for (let i = 0; i < count; i++) {
                const angle = (Math.PI * 2 * i) / count + Math.random() * 0.2;
                const speed = 1.6 + Math.random() * 3.4;
                particles.push({
                    x: cx, y: cy,
                    vx: Math.cos(angle) * speed,
                    vy: Math.sin(angle) * speed,
                    life: 0,
                    maxLife: 55 + Math.random() * 35,
                    color,
                    size: 1.5 + Math.random() * 2,
                });
            }
        };

        const tick = (t: number) => {
            if (Date.now() > stopRef.current && particles.length === 0) {
                setActive(false);
                return;
            }
            if (Date.now() < stopRef.current && t - lastBurst > 420 + Math.random() * 380) {
                lastBurst = t;
                burst();
            }
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            for (let i = particles.length - 1; i >= 0; i--) {
                const p = particles[i];
                p.life++;
                p.x += p.vx;
                p.y += p.vy;
                p.vy += 0.035;   // gravity
                p.vx *= 0.985;   // drag
                if (p.life > p.maxLife) { particles.splice(i, 1); continue; }
                const fade = 1 - p.life / p.maxLife;
                ctx.globalAlpha = fade;
                ctx.fillStyle = p.color;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.size * fade + 0.4, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [active]);

    if (!active) return null;
    return (
        <canvas
            ref={canvasRef}
            className="fixed inset-0 z-[290] pointer-events-none"
            aria-hidden="true"
            data-testid="titan-fireworks"
        />
    );
}
