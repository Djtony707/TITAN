import React, { useEffect, useRef } from 'react';

/**
 * TITAN Canvas Backdrop — desktop work-surface grid with subtle motion.
 */
export function CanvasBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const gridSize = 28;
    let time = 0;

    function resize() {
      if (!canvas) return;
      const scale = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(window.innerWidth * scale));
      canvas.height = Math.max(1, Math.floor(window.innerHeight * scale));
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      ctx?.setTransform(scale, 0, 0, scale, 0, 0);
    }

    function cssVar(name: string, fallback: string): string {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    }

    function draw() {
      if (!ctx || !canvas) return;
      const width = window.innerWidth;
      const height = window.innerHeight;
      const bg = cssVar('--theme-bg-base', '#09090b');
      const line = cssVar('--theme-metal', '#b08a3a');
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      // Subtle radial vignette
      const gradient = ctx.createRadialGradient(
        width * 0.5, height * 0.34, 0,
        width * 0.5, height * 0.34, Math.max(width, height) * 0.82
      );
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.035)');
      gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.012)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      if (!prefersReducedMotion) time += 0.0025;

      ctx.strokeStyle = colorWithAlpha(line, 0.14);
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      const drift = prefersReducedMotion ? 0 : Math.sin(time) * 4;

      for (let x = -gridSize; x < width + gridSize; x += gridSize) {
        ctx.moveTo(x + drift, 0);
        ctx.lineTo(x + drift, height);
      }
      for (let y = -gridSize; y < height + gridSize; y += gridSize) {
        ctx.moveTo(0, y - drift);
        ctx.lineTo(width, y - drift);
      }
      ctx.stroke();

      if (!prefersReducedMotion) animationId = requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener('resize', resize);

    return () => {
      if (animationId) cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      style={{ background: 'var(--theme-bg-base, #09090b)' }}
    />
  );
}

function colorWithAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && (color.length === 7 || color.length === 4)) {
    const full = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
    const r = Number.parseInt(full.slice(1, 3), 16);
    const g = Number.parseInt(full.slice(3, 5), 16);
    const b = Number.parseInt(full.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return `rgba(176, 138, 58, ${alpha})`;
}
