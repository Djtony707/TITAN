/**
 * Titan 3.0 SOMA Orb
 * Persistent ambient consciousness indicator.
 * Click to expand SOMA widget. Right-click for quick actions.
 */

import React, { useState, useEffect, useRef } from 'react';
import { SomaWidget } from './SomaWidget';
import { Brain, X, Activity, Sparkles, MessageCircle, Zap } from 'lucide-react';
import { apiFetch } from '@/api/client';

type SomaEmotion = 'calm' | 'focused' | 'excited' | 'concerned' | 'dreaming';

interface SomaState {
  emotion: SomaEmotion;
  intensity: number; // 0-1
  activity: string;
}

const EMOTION_COLORS: Record<SomaEmotion, { primary: string; glow: string; pulse: string }> = {
  calm:      { primary: '#6366f1', glow: 'rgba(99,102,241,0.4)',  pulse: 'rgba(99,102,241,0.15)' },
  focused:   { primary: '#10b981', glow: 'rgba(16,185,129,0.4)',  pulse: 'rgba(16,185,129,0.15)' },
  excited:   { primary: '#f59e0b', glow: 'rgba(245,158,11,0.4)',  pulse: 'rgba(245,158,11,0.15)' },
  concerned: { primary: '#ef4444', glow: 'rgba(239,68,68,0.4)',   pulse: 'rgba(239,68,68,0.15)' },
  dreaming:  { primary: '#8b5cf6', glow: 'rgba(139,92,246,0.4)',  pulse: 'rgba(139,92,246,0.15)' },
};

/** Map real SOMA drive data to an emotion + activity label. */
function deriveSomaState(
  totalPressure: number,
  dominantDrives: string[],
  enabled: boolean,
): SomaState {
  if (!enabled) {
    return { emotion: 'dreaming', intensity: 0.25, activity: 'Dormant' };
  }
  const dominant = dominantDrives[0];
  const intensity = Math.min(1, totalPressure / 2);

  switch (dominant) {
    case 'purpose':   return { emotion: 'focused',   intensity: 0.4 + intensity * 0.4, activity: 'Pursuing purpose' };
    case 'curiosity': return { emotion: 'excited',   intensity: 0.4 + intensity * 0.5, activity: 'Exploring' };
    case 'hunger':    return { emotion: 'focused',   intensity: 0.5 + intensity * 0.3, activity: 'Satiating' };
    case 'safety':    return { emotion: 'concerned', intensity: 0.5 + intensity * 0.4, activity: 'Securing' };
    case 'social':    return { emotion: 'calm',      intensity: 0.3 + intensity * 0.3, activity: 'Connecting' };
    case 'rest':      return { emotion: 'dreaming',  intensity: 0.2 + intensity * 0.2, activity: 'Recuperating' };
    default:
      return totalPressure > 0.5
        ? { emotion: 'focused', intensity, activity: 'Processing' }
        : { emotion: 'calm', intensity: 0.3, activity: 'Observing' };
  }
}

export function SomaOrb() {
  const [expanded, setExpanded] = useState(false);
  const [somaState, setSomaState] = useState<SomaState>({ emotion: 'calm', intensity: 0.3, activity: 'Observing' });
  const [showMenu, setShowMenu] = useState(false);
  const [position, setPosition] = useState({ x: 24, y: 80 });
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const orbRef = useRef<HTMLDivElement>(null);

  // Poll real SOMA state
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiFetch('/api/soma/state');
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        setSomaState(deriveSomaState(
          Number(data?.totalPressure ?? 0),
          Array.isArray(data?.dominantDrives) ? data.dominantDrives : [],
          Boolean(data?.enabled),
        ));
      } catch { /* ignore — orb degrades to last known state */ }
    };
    poll();
    const interval = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Close menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!orbRef.current?.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, []);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragOffset.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
    setDragging(true);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    setPosition({
      x: e.clientX - dragOffset.current.x,
      y: e.clientY - dragOffset.current.y,
    });
  };

  const handleMouseUp = () => {
    setDragging(false);
  };

  const colors = EMOTION_COLORS[somaState.emotion];

  return (
    <>
      {/* Expanded SOMA Panel */}
      {expanded && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setExpanded(false)}>
          <div
            className="bg-[#18181b]/98 border border-[#27272a]/60 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden"
            style={{ width: 'min(900px, 90vw)', height: 'min(600px, 80vh)' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-[#27272a]/40">
              <div className="flex items-center gap-2">
                <Brain className="w-4 h-4" style={{ color: colors.primary }} />
                <span className="text-[11px] font-bold uppercase tracking-wider text-[#a1a1aa]">SOMA Consciousness</span>
              </div>
              <button onClick={() => setExpanded(false)} className="p-1 text-[#3f3f46] hover:text-[#71717a]">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="h-[calc(100%-40px)]">
              <SomaWidget />
            </div>
          </div>
        </div>
      )}

      {/* SOMA Orb */}
      <div
        ref={orbRef}
        className="fixed z-50 select-none"
        style={{ left: position.x, top: position.y }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {/* Context menu */}
        {showMenu && (
          <div className="absolute bottom-full left-0 mb-2 bg-[#18181b]/98 backdrop-blur-xl border border-[#27272a]/60 rounded-xl shadow-2xl shadow-black/60 overflow-hidden min-w-[160px] py-1">
            <button
              onClick={() => { setExpanded(true); setShowMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] text-[#a1a1aa] hover:bg-[#27272a]/40 transition-colors"
            >
              <Brain className="w-3.5 h-3.5" style={{ color: colors.primary }} />
              Open SOMA
            </button>
            <button
              onClick={() => { setShowMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] text-[#a1a1aa] hover:bg-[#27272a]/40 transition-colors"
            >
              <Sparkles className="w-3.5 h-3.5 text-[#f59e0b]" />
              Summarize Canvas
            </button>
            <button
              onClick={() => { setShowMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-[11px] text-[#a1a1aa] hover:bg-[#27272a]/40 transition-colors"
            >
              <Zap className="w-3.5 h-3.5 text-[#6366f1]" />
              Run Self-Check
            </button>
          </div>
        )}

        {/* Orb body */}
        <div
          className="relative cursor-pointer group"
          onClick={() => !dragging && setExpanded(true)}
          onContextMenu={e => { e.preventDefault(); setShowMenu(true); }}
        >
          {/* Outer glow rings */}
          <div
            className="absolute inset-0 rounded-full animate-ping opacity-20"
            style={{
              background: colors.pulse,
              animationDuration: `${3 - somaState.intensity * 2}s`,
            }}
          />
          <div
            className="absolute -inset-2 rounded-full opacity-30 blur-md transition-all duration-1000"
            style={{ background: colors.glow }}
          />

          {/* Core orb */}
          <div
            className="relative w-12 h-12 rounded-full flex items-center justify-center transition-all duration-500 hover:scale-110"
            style={{
              background: `radial-gradient(circle at 30% 30%, ${colors.primary}, ${colors.primary}88)`,
              boxShadow: `0 0 ${20 + somaState.intensity * 30}px ${colors.glow}, inset 0 0 10px rgba(255,255,255,0.1)`,
            }}
          >
            <Brain className="w-5 h-5 text-white/90" />
          </div>

          {/* Activity label */}
          <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap">
            <span className="text-[9px] font-medium uppercase tracking-wider text-[#52525b] bg-[#0a0a0f]/80 px-1.5 py-0.5 rounded">
              {somaState.activity}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
