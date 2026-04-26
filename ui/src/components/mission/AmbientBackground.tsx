/**
 * TITAN — Mission View Ambient Background
 *
 * Subtle animated mesh gradient that sits behind the chat.
 * Uses CSS animations (not canvas) for performance and reduced-motion support.
 */
import { useEffect, useState } from 'react';

export default function AmbientBackground() {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  if (reducedMotion) {
    return <div className="absolute inset-0 bg-bg -z-10" />;
  }

  return (
    <div className="absolute inset-0 -z-10 overflow-hidden bg-bg">
      {/* Base gradient */}
      <div
        className="absolute inset-0 opacity-40"
        style={{
          background:
            'radial-gradient(ellipse at 20% 30%, rgba(99,102,241,0.12) 0%, transparent 50%), radial-gradient(ellipse at 80% 70%, rgba(236,72,153,0.08) 0%, transparent 50%), radial-gradient(ellipse at 50% 50%, rgba(34,211,238,0.05) 0%, transparent 60%)',
        }}
      />

      {/* Animated orbs */}
      <div
        className="absolute w-[600px] h-[600px] rounded-full opacity-20"
        style={{
          background: 'radial-gradient(circle, rgba(99,102,241,0.25) 0%, transparent 70%)',
          filter: 'blur(80px)',
          animation: 'ambientFloat1 20s ease-in-out infinite',
          top: '-10%',
          left: '-10%',
        }}
      />
      <div
        className="absolute w-[500px] h-[500px] rounded-full opacity-15"
        style={{
          background: 'radial-gradient(circle, rgba(236,72,153,0.2) 0%, transparent 70%)',
          filter: 'blur(80px)',
          animation: 'ambientFloat2 25s ease-in-out infinite',
          bottom: '-10%',
          right: '-5%',
        }}
      />
      <div
        className="absolute w-[400px] h-[400px] rounded-full opacity-10"
        style={{
          background: 'radial-gradient(circle, rgba(34,211,238,0.18) 0%, transparent 70%)',
          filter: 'blur(80px)',
          animation: 'ambientFloat3 18s ease-in-out infinite',
          top: '40%',
          left: '60%',
        }}
      />

      {/* Subtle grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.015]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />

      {/* Edge vignette */}
      <div
        className="absolute inset-0"
        style={{
          boxShadow: 'inset 0 0 150px 60px rgba(0,0,0,0.4)',
        }}
      />

      <style>{`
        @keyframes ambientFloat1 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(60px, 40px) scale(1.1); }
          66% { transform: translate(-30px, 80px) scale(0.95); }
        }
        @keyframes ambientFloat2 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          50% { transform: translate(-50px, -60px) scale(1.15); }
        }
        @keyframes ambientFloat3 {
          0%, 100% { transform: translate(0, 0) scale(1); }
          25% { transform: translate(40px, -30px) scale(1.05); }
          75% { transform: translate(-20px, 50px) scale(0.9); }
        }
      `}</style>
    </div>
  );
}
