import React, { useEffect, useRef } from 'react';

/**
 * TITAN Canvas Backdrop — animated hex grid with subtle pulse.
 * Unique to TITAN. Not a starfield copy.
 */
export function CanvasBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    const hexSize = 24;
    const hexHeight = hexSize * Math.sqrt(3);
    const hexWidth = hexSize * 2;
    let time = 0;

    function resize() {
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }

    function drawHex(x: number, y: number, size: number, opacity: number) {
      if (!ctx) return;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        const hx = x + size * Math.cos(angle);
        const hy = y + size * Math.sin(angle);
        if (i === 0) ctx.moveTo(hx, hy);
        else ctx.lineTo(hx, hy);
      }
      ctx.closePath();
      ctx.strokeStyle = `rgba(99, 102, 241, ${opacity})`;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }

    function draw() {
      if (!ctx || !canvas) return;
      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Subtle radial vignette
      const gradient = ctx.createRadialGradient(
        canvas.width * 0.5, canvas.height * 0.4, 0,
        canvas.width * 0.5, canvas.height * 0.4, canvas.width * 0.8
      );
      gradient.addColorStop(0, 'rgba(99, 102, 241, 0.03)');
      gradient.addColorStop(0.4, 'rgba(168, 85, 247, 0.01)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      time += 0.003;

      // Draw hex grid
      const cols = Math.ceil(canvas.width / (hexWidth * 0.75)) + 1;
      const rows = Math.ceil(canvas.height / hexHeight) + 1;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * hexWidth * 0.75;
          const y = row * hexHeight + (col % 2) * (hexHeight / 2);

          // Wave-like opacity based on position + time
          const wave = Math.sin(x * 0.005 + time) * Math.cos(y * 0.005 + time * 0.7);
          const opacity = 0.03 + wave * 0.02;

          drawHex(x, y, hexSize - 1, Math.max(0, opacity));
        }
      }

      // Scanline sweep
      const scanY = ((time * 80) % (canvas.height + 200)) - 100;
      const scanGradient = ctx.createLinearGradient(0, scanY - 30, 0, scanY + 30);
      scanGradient.addColorStop(0, 'rgba(99, 102, 241, 0)');
      scanGradient.addColorStop(0.5, 'rgba(99, 102, 241, 0.04)');
      scanGradient.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = scanGradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      animationId = requestAnimationFrame(draw);
    }

    resize();
    draw();
    window.addEventListener('resize', resize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-0 pointer-events-none"
      style={{ background: '#09090b' }}
    />
  );
}
