import { useState } from 'react';
import { X, Monitor, Gamepad2 } from 'lucide-react';
import { ActivityCards } from './ActivityCards';
import { PixelOffice } from './PixelOffice';
import type { AgentEvent } from '@/api/types';

type ViewMode = 'cards' | 'pixel';

export function AgentWatcher({ events, onClose }: { events: AgentEvent[]; onClose: () => void }) {
  const [mode, setMode] = useState<ViewMode>('cards');

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Agent Watcher</span>

        <div className="flex items-center gap-1">
          {/* View toggle */}
          <div className="flex bg-bg-secondary rounded-lg p-0.5">
            <button
              onClick={() => setMode('cards')}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors duration-200"
              style={{
                backgroundColor: mode === 'cards' ? '#27272a' : 'transparent',
                color: mode === 'cards' ? '#fafafa' : '#52525b',
              }}
            >
              <Monitor className="w-3 h-3" />
              Cards
            </button>
            <button
              onClick={() => setMode('pixel')}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors duration-200"
              style={{
                backgroundColor: mode === 'pixel' ? '#27272a' : 'transparent',
                color: mode === 'pixel' ? '#fafafa' : '#52525b',
              }}
            >
              <Gamepad2 className="w-3 h-3" />
              Pixel
            </button>
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-bg-tertiary text-text-muted hover:text-text-secondary transition-colors duration-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {mode === 'cards' ? (
          <ActivityCards events={events} />
        ) : (
          <PixelOffice events={events} />
        )}
      </div>
    </div>
  );
}
