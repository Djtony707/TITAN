import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronLeft, ChevronRight, Volume2, Upload } from 'lucide-react';
import { apiFetch } from '@/api/client';

export interface VoiceOption {
  id: string;
  name: string;
  description: string;
  gradient: string;
  glow: string;
}

/** Built-in voice presets — only used when no cloned voices exist */
const BUILTIN_VOICES: Record<string, Omit<VoiceOption, 'id'>> = {
  default: {
    name: 'Default',
    description: 'F5-TTS base voice',
    gradient: 'radial-gradient(circle at 35% 35%, #c084fc, #a855f7, #7c3aed)',
    glow: '#a855f7',
  },
};

/** Color palette for cloned voices (cycled deterministically) */
const VOICE_COLORS = [
  { gradient: 'radial-gradient(circle at 35% 35%, #93c5fd, #3b82f6, #1d4ed8)', glow: '#3b82f6' },
  { gradient: 'radial-gradient(circle at 35% 35%, #fbbf24, #f59e0b, #b45309)', glow: '#f59e0b' },
  { gradient: 'radial-gradient(circle at 35% 35%, #5eead4, #14b8a6, #0f766e)', glow: '#14b8a6' },
  { gradient: 'radial-gradient(circle at 35% 35%, #fda4af, #fb7185, #e11d48)', glow: '#fb7185' },
  { gradient: 'radial-gradient(circle at 35% 35%, #a5b4fc, #818cf8, #4f46e5)', glow: '#818cf8' },
  { gradient: 'radial-gradient(circle at 35% 35%, #fdba74, #f97316, #c2410c)', glow: '#f97316' },
  { gradient: 'radial-gradient(circle at 35% 35%, #86efac, #22c55e, #15803d)', glow: '#22c55e' },
  { gradient: 'radial-gradient(circle at 35% 35%, #67e8f9, #22d3ee, #0891b2)', glow: '#22d3ee' },
];

function buildVoiceOptions(voiceIds: string[]): VoiceOption[] {
  return voiceIds.map((id, i) => {
    const preset = BUILTIN_VOICES[id];
    if (preset) return { id, ...preset };
    const color = VOICE_COLORS[i % VOICE_COLORS.length];
    const name = id.charAt(0).toUpperCase() + id.slice(1);
    return {
      id,
      name,
      description: 'Cloned voice',
      gradient: color.gradient,
      glow: color.glow,
    };
  });
}

/** Export voice data for use by other components */
export function getVoiceInfo(voiceId: string): { name: string; glow: string } {
  const preset = BUILTIN_VOICES[voiceId];
  if (preset) return { name: preset.name, glow: preset.glow };
  const idx = VOICE_COLORS.findIndex((_, i) => i === voiceId.length % VOICE_COLORS.length);
  const color = VOICE_COLORS[idx >= 0 ? idx : 0];
  return { name: voiceId.charAt(0).toUpperCase() + voiceId.slice(1), glow: color.glow };
}

interface VoicePickerProps {
  currentVoice?: string;
  onSelect: (voiceId: string) => void;
  onPreview?: (voiceId: string) => void;
}

export function VoicePicker({ currentVoice, onSelect, onPreview }: VoicePickerProps) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIdx, setActiveIdx] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const startX = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetch cloned voices from F5-TTS server
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await apiFetch('/api/voice/voices');
        if (res.ok) {
          const data = await res.json();
          const ids = data.voices?.length ? data.voices : ['default'];
          const opts = buildVoiceOptions(ids);
          setVoices(opts);
          if (currentVoice) {
            const idx = opts.findIndex(v => v.id === currentVoice);
            if (idx >= 0) setActiveIdx(idx);
          }
        } else {
          setVoices(buildVoiceOptions(['default']));
        }
      } catch {
        setVoices(buildVoiceOptions(['default']));
      } finally {
        setLoading(false);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const voice = voices[activeIdx] || voices[0];

  const goTo = useCallback((idx: number) => {
    setActiveIdx(Math.max(0, Math.min(voices.length - 1, idx)));
  }, [voices.length]);

  const prev = useCallback(() => goTo(activeIdx - 1), [activeIdx, goTo]);
  const next = useCallback(() => goTo(activeIdx + 1), [activeIdx, goTo]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') prev();
      if (e.key === 'ArrowRight') next();
      if (e.key === 'Enter') onSelect(voices[activeIdx].id);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeIdx, prev, next, onSelect, voices]);

  // Touch/mouse drag
  const onPointerDown = (e: React.PointerEvent) => {
    setIsDragging(true);
    startX.current = e.clientX;
    setDragOffset(0);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging) return;
    setDragOffset(e.clientX - startX.current);
  };

  const onPointerUp = () => {
    if (!isDragging) return;
    setIsDragging(false);
    if (dragOffset > 60) prev();
    else if (dragOffset < -60) next();
    setDragOffset(0);
  };

  if (loading || voices.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full select-none">
        <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mb-4" />
        <p className="text-sm text-text-muted">Loading voices...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full select-none">
      {/* Title */}
      <h2 className="text-xl font-semibold text-text mb-2">Choose a voice</h2>
      <p className="text-sm text-text-muted mb-10">
        {voices.length > 1 ? `${voices.length} cloned voices available` : 'Swipe or use arrow keys'}
      </p>

      {/* Orb carousel */}
      <div
        ref={containerRef}
        className="relative flex items-center justify-center w-full"
        style={{ height: 280, touchAction: 'pan-y' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        {/* Left arrow */}
        {activeIdx > 0 && (
          <button
            onClick={prev}
            className="absolute left-4 z-10 rounded-full p-2 text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
          >
            <ChevronLeft size={28} />
          </button>
        )}

        {/* Orbs */}
        <div className="relative" style={{ width: 220, height: 220 }}>
          {voices.map((v, i) => {
            const offset = i - activeIdx;
            const isActive = i === activeIdx;
            const drag = isDragging ? dragOffset * 0.3 : 0;
            return (
              <div
                key={v.id}
                className="absolute inset-0 transition-all"
                style={{
                  transitionDuration: isDragging ? '0ms' : '400ms',
                  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                  transform: `translateX(${offset * 260 + drag}px) scale(${isActive ? 1 : 0.7})`,
                  opacity: Math.abs(offset) > 1 ? 0 : isActive ? 1 : 0.4,
                  zIndex: isActive ? 10 : 1,
                  pointerEvents: isActive ? 'auto' : 'none',
                }}
              >
                {/* Glow */}
                <div
                  className="absolute inset-0 rounded-full blur-2xl transition-opacity duration-500"
                  style={{
                    background: v.glow,
                    opacity: isActive ? 0.3 : 0,
                    transform: 'scale(1.2)',
                  }}
                />
                {/* Orb */}
                <div
                  className="w-full h-full rounded-full shadow-2xl"
                  style={{
                    background: v.gradient,
                    boxShadow: isActive ? `0 0 60px ${v.glow}40` : 'none',
                  }}
                />
                {/* Inner highlight */}
                <div
                  className="absolute rounded-full"
                  style={{
                    top: '12%',
                    left: '18%',
                    width: '35%',
                    height: '35%',
                    background: 'radial-gradient(circle, rgba(255,255,255,0.4) 0%, transparent 70%)',
                  }}
                />
              </div>
            );
          })}
        </div>

        {/* Right arrow */}
        {activeIdx < voices.length - 1 && (
          <button
            onClick={next}
            className="absolute right-4 z-10 rounded-full p-2 text-text-muted hover:text-text hover:bg-bg-tertiary transition-colors"
          >
            <ChevronRight size={28} />
          </button>
        )}
      </div>

      {/* Voice name + description */}
      <div className="mt-8 text-center">
        <h3 className="text-2xl font-bold text-text mb-1">{voice.name}</h3>
        <p className="text-sm text-text-secondary">{voice.description}</p>

      </div>

      {/* Preview button */}
      {onPreview && (
        <button
          onClick={() => onPreview(voice.id)}
          className="mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-text-secondary hover:text-text hover:bg-bg-tertiary transition-colors"
        >
          <Volume2 size={14} />
          Preview
        </button>
      )}

      {/* Dots */}
      <div className="flex items-center gap-2 mt-6">
        {voices.map((v, i) => (
          <button
            key={v.id}
            onClick={() => goTo(i)}
            className="rounded-full transition-all duration-300"
            style={{
              width: i === activeIdx ? 10 : 6,
              height: i === activeIdx ? 10 : 6,
              backgroundColor: i === activeIdx ? voice.glow : 'var(--color-border)',
              boxShadow: i === activeIdx ? `0 0 8px ${voice.glow}80` : 'none',
            }}
          />
        ))}
      </div>

      {/* Done button */}
      <button
        onClick={() => onSelect(voice.id)}
        className="mt-10 w-72 rounded-full py-3.5 text-base font-semibold transition-all duration-200"
        style={{
          background: `linear-gradient(135deg, ${voice.glow}30, ${voice.glow}15)`,
          border: `1px solid ${voice.glow}40`,
          color: 'var(--color-text)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = `linear-gradient(135deg, ${voice.glow}50, ${voice.glow}25)`;
          e.currentTarget.style.boxShadow = `0 0 20px ${voice.glow}30`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = `linear-gradient(135deg, ${voice.glow}30, ${voice.glow}15)`;
          e.currentTarget.style.boxShadow = 'none';
        }}
      >
        Start with {voice.name}
      </button>
    </div>
  );
}

/** Export VOICES for backward compatibility */
export const VOICES = buildVoiceOptions(['default']);
