import { useRef, useEffect, useCallback } from 'react';

interface MiniFluidBubbleProps {
  size?: number;
  disabled?: boolean;
  onClick?: () => void;
}

export function MiniFluidBubble({ size = 28, disabled = false, onClick }: MiniFluidBubbleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const timeRef = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = size * dpr;
    const h = size * dpr;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    // Slow down animation when disabled
    const speed = disabled ? 0.15 : 1;
    timeRef.current += 0.016 * speed;
    const t = timeRef.current;

    const cx = w / 2;
    const cy = h / 2;
    const baseR = w * 0.38;

    // === Outer glow layer ===
    if (!disabled) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.beginPath();
      const glowPoints = 60;
      for (let i = 0; i <= glowPoints; i++) {
        const angle = (i / glowPoints) * Math.PI * 2;
        const n1 = Math.sin(angle * 3 + t * 1.2) * 0.06;
        const n2 = Math.sin(angle * 5 - t * 0.8) * 0.04;
        const r = baseR * 1.2 * (1 + n1 + n2);
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      const glowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, baseR * 1.4);
      glowGrad.addColorStop(0, 'rgba(120, 97, 243, 0.15)');
      glowGrad.addColorStop(0.6, 'rgba(120, 97, 243, 0.06)');
      glowGrad.addColorStop(1, 'rgba(120, 97, 243, 0)');
      ctx.fillStyle = glowGrad;
      ctx.fill();
      ctx.restore();
    }

    // === Main orb body ===
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    const points = 80;
    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;

      // 3 noise frequencies for organic wobble
      const n1 = Math.sin(angle * 3 + t * 1.5) * 0.05;
      const n2 = Math.sin(angle * 5 - t * 1.0) * 0.03;
      const n3 = Math.sin(angle * 7 + t * 2.1) * 0.02;

      // Gentle breathing pulse
      const breathe = Math.sin(t * 0.9) * 0.03;

      const r = baseR * (1 + n1 + n2 + n3 + breathe);
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    // Gradient fill — indigo to purple
    const mainGrad = ctx.createRadialGradient(
      -baseR * 0.2, -baseR * 0.25, baseR * 0.05,
      0, 0, baseR * 1.1,
    );
    mainGrad.addColorStop(0, 'rgba(160, 140, 255, 0.95)');
    mainGrad.addColorStop(0.4, 'rgba(99, 102, 241, 0.9)');
    mainGrad.addColorStop(1, 'rgba(109, 72, 206, 0.85)');
    ctx.fillStyle = mainGrad;
    ctx.fill();

    // Upper-left shimmer/highlight
    const shimmerGrad = ctx.createRadialGradient(
      -baseR * 0.3, -baseR * 0.35, 0,
      -baseR * 0.1, -baseR * 0.15, baseR * 0.5,
    );
    const shimmerAlpha = 0.25 + Math.sin(t * 1.3) * 0.08;
    shimmerGrad.addColorStop(0, `rgba(255, 255, 255, ${shimmerAlpha})`);
    shimmerGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.06)');
    shimmerGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = shimmerGrad;
    ctx.fill();
    ctx.restore();

    animRef.current = requestAnimationFrame(draw);
  }, [size, disabled]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-9 w-9 items-center justify-center rounded-xl transition-all hover:bg-bg-tertiary focus:outline-none"
      aria-label="Voice input"
      title={disabled ? 'Voice not configured' : 'Voice chat'}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: size,
          height: size,
          opacity: disabled ? 0.3 : 1,
          filter: disabled ? 'none' : 'drop-shadow(0 0 4px rgba(120, 97, 243, 0.5)) drop-shadow(0 0 8px rgba(139, 92, 246, 0.25))',
          transition: 'opacity 0.3s ease, filter 0.3s ease',
        }}
      />
    </button>
  );
}
