/**
 * Titan 3.0 Voice Widget
 * Direct access to the full Voice Overlay as a Canvas widget.
 * F5-TTS only. No Orpheus, no Qwen3, no browser fallback.
 */

import React, { useState } from 'react';
import { VoiceOverlay } from '@/components/voice/VoiceOverlay';
import { Mic, MicOff } from 'lucide-react';

export function VoiceWidget() {
  const [active, setActive] = useState(false);

  if (active) {
    return <VoiceOverlay onClose={() => setActive(false)} />;
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-[#09090b]">
      <button
        onClick={() => setActive(true)}
        className="group relative flex flex-col items-center gap-4"
      >
        {/* Orb */}
        <div className="relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 group-hover:scale-110">
          <div className="absolute inset-0 rounded-full bg-[#6366f1]/20 animate-pulse" />
          <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#6366f1]/30 to-[#4f46e5]/10 border border-[#6366f1]/30" />
          <Mic className="w-8 h-8 text-[#818cf8] relative z-10" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-[#a1a1aa]">Tap to speak</p>
          <p className="text-[10px] text-[#52525b] mt-1">F5-TTS · Voice Cloning</p>
        </div>
      </button>
    </div>
  );
}
