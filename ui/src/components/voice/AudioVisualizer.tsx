import { useRef, useEffect, useCallback, useMemo, useState } from 'react';

interface AudioVisualizerProps {
  type?: 'bar' | 'wave' | 'radial';
  color?: string;
  active?: boolean;
  audioLevel?: number; // 0–1, drives reactivity
}

export function AudioVisualizer({
  type = 'wave',
  color = 'var(--color-accent)',
  active = false,
  audioLevel = 0,
}: AudioVisualizerProps) {
  if (type === 'bar') return <BarVisualizer color={color} active={active} audioLevel={audioLevel} />;
  if (type === 'wave') return <WaveVisualizer color={color} active={active} audioLevel={audioLevel} />;
  return <RadialVisualizer color={color} active={active} audioLevel={audioLevel} />;
}

// ─── Wave Visualizer (Canvas-based) ─────────────────────────────────

function WaveVisualizer({ color, active, audioLevel }: { color: string; active: boolean; audioLevel: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const phaseRef = useRef(0);
  const smoothLevel = useRef(0);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const midY = H / 2;

    // Smooth the audio level for fluid motion
    const target = active ? Math.max(audioLevel, 0.15) : 0;
    smoothLevel.current += (target - smoothLevel.current) * 0.12;
    const level = smoothLevel.current;

    ctx.clearRect(0, 0, W, H);

    // Draw multiple layered sine waves
    const waves = [
      { amp: 40, freq: 0.015, speed: 0.04, alpha: 0.9, width: 3 },
      { amp: 25, freq: 0.025, speed: -0.03, alpha: 0.5, width: 2 },
      { amp: 15, freq: 0.04, speed: 0.05, alpha: 0.3, width: 1.5 },
    ];

    phaseRef.current += 1;

    for (const wave of waves) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.globalAlpha = wave.alpha * Math.min(level * 3, 1);
      ctx.lineWidth = wave.width;
      ctx.lineCap = 'round';

      for (let x = 0; x <= W; x++) {
        const normalX = x / W;
        // Envelope: fade at edges
        const envelope = Math.sin(normalX * Math.PI);
        const y =
          midY +
          Math.sin(x * wave.freq + phaseRef.current * wave.speed) *
            wave.amp *
            level *
            envelope;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    animRef.current = requestAnimationFrame(draw);
  }, [active, audioLevel, color]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, [draw]);

  return (
    <div className="flex items-center justify-center" style={{ width: 240, height: 240 }}>
      <canvas
        ref={canvasRef}
        width={240}
        height={120}
        style={{ width: 240, height: 120 }}
      />
    </div>
  );
}

// ─── Bar Visualizer (transform-based) ───────────────────────────────

function BarVisualizer({ color, active, audioLevel }: { color: string; active: boolean; audioLevel: number }) {
  const barCount = 9;
  const bars = useMemo(() => {
    return Array.from({ length: barCount }, (_, i) => ({
      phase: (i / barCount) * Math.PI * 2,
    }));
  }, []);

  const smoothLevel = useRef(0);
  const [heights, setHeights] = useState<number[]>(new Array(barCount).fill(8));
  const animRef = useRef<number>(0);
  const frameRef = useRef(0);

  useEffect(() => {
    let running = true;

    function tick() {
      if (!running) return;
      const target = active ? Math.max(audioLevel, 0.1) : 0;
      smoothLevel.current += (target - smoothLevel.current) * 0.15;
      frameRef.current += 1;

      const newHeights = bars.map((bar) => {
        const wave = Math.sin(frameRef.current * 0.08 + bar.phase) * 0.5 + 0.5;
        const h = 8 + wave * smoothLevel.current * 100;
        return Math.max(8, Math.min(h, 120));
      });

      setHeights(newHeights);
      animRef.current = requestAnimationFrame(tick);
    }

    animRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [active, audioLevel, bars]);

  return (
    <div className="flex items-end justify-center gap-1.5" style={{ width: 240, height: 240, alignItems: 'center' }}>
      {heights.map((h, i) => (
        <div
          key={i}
          style={{
            width: 6,
            height: h,
            borderRadius: 3,
            backgroundColor: color,
            transition: 'height 0.05s linear',
          }}
        />
      ))}
    </div>
  );
}

// ─── Radial Visualizer ──────────────────────────────────────────────

function RadialVisualizer({ color, active, audioLevel }: { color: string; active: boolean; audioLevel: number }) {
  const level = active ? Math.max(audioLevel, 0.2) : 0;
  const scale = 1 + level * 0.4;

  return (
    <div className="flex items-center justify-center relative" style={{ width: 240, height: 240 }}>
      <div
        style={{
          width: 120,
          height: 120,
          borderRadius: '50%',
          border: `3px solid ${color}`,
          transform: `scale(${scale})`,
          transition: 'transform 0.15s ease-out',
          opacity: active ? 1 : 0.4,
        }}
      />
      {active && (
        <div
          style={{
            position: 'absolute',
            width: 120,
            height: 120,
            borderRadius: '50%',
            border: `2px solid ${color}`,
            animation: 'radialPulse 1.2s ease-in-out 0.3s infinite',
            opacity: 0.5,
          }}
        />
      )}
      <style>{`
        @keyframes radialPulse {
          0%, 100% { transform: scale(1); opacity: 0.8; }
          50% { transform: scale(1.3); opacity: 0.2; }
        }
      `}</style>
    </div>
  );
}
