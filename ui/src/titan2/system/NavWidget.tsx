/**
 * Titan 3.0 Nav Widget
 * Floating space launcher. Replaces the sidebar.
 */

import React, { useState } from 'react';
import { SpaceEngine } from '../canvas/SpaceEngine';
import { Plus, ChevronUp, Home, Brain, Terminal, Network, Server, Wrench, Settings, FileText } from 'lucide-react';

const ICONS: Record<string, React.ReactNode> = {
  Home: <Home className="w-3.5 h-3.5" />,
  Brain: <Brain className="w-3.5 h-3.5" />,
  Terminal: <Terminal className="w-3.5 h-3.5" />,
  Network: <Network className="w-3.5 h-3.5" />,
  Server: <Server className="w-3.5 h-3.5" />,
  Wrench: <Wrench className="w-3.5 h-3.5" />,
  Settings: <Settings className="w-3.5 h-3.5" />,
  FileText: <FileText className="w-3.5 h-3.5" />,
};

interface Props {
  currentSpaceId: string;
  onSpaceSelect: (id: string) => void;
}

export function NavWidget({ currentSpaceId, onSpaceSelect }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [newName, setNewName] = useState('');
  const spaces = SpaceEngine.list();

  const handleCreate = () => {
    if (!newName.trim()) return;
    const space = SpaceEngine.create(newName.trim());
    setNewName('');
    onSpaceSelect(space.id);
  };

  return (
    <div className="bg-[#18181b]/95 backdrop-blur-xl border border-[#27272a]/60 rounded-2xl shadow-2xl shadow-black/40 overflow-hidden min-w-[180px]">
      {/* Toggle */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-[#27272a]/40 transition-colors"
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-[#52525b]">Spaces</span>
        <ChevronUp className={`w-3.5 h-3.5 text-[#3f3f46] transition-transform ${expanded ? '' : 'rotate-180'}`} />
      </button>

      {expanded && (
        <div className="px-2 pb-2">
          <div className="space-y-0.5">
            {spaces.map(space => (
              <button
                key={space.id}
                onClick={() => onSpaceSelect(space.id)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-left text-[11px] transition-colors ${
                  space.id === currentSpaceId
                    ? 'bg-[#6366f1]/10 text-[#818cf8]'
                    : 'text-[#71717a] hover:bg-[#27272a]/40 hover:text-[#a1a1aa]'
                }`}
              >
                <span style={{ color: space.color || '#52525b' }}>
                  {ICONS[space.icon || ''] || <div className="w-3.5 h-3.5 rounded-full" style={{ background: space.color || '#52525b' }} />}
                </span>
                <span className="truncate">{space.name}</span>
              </button>
            ))}
          </div>

          {/* Create new */}
          <div className="mt-2 pt-2 border-t border-[#27272a]/40 flex gap-1.5">
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="New space..."
              className="flex-1 min-w-0 px-2 py-1 rounded-lg bg-[#0a0a0f] border border-[#27272a] text-[11px] text-[#a1a1aa] placeholder:text-[#3f3f46] outline-none focus:border-[#6366f1]/30"
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim()}
              className="p-1.5 rounded-lg bg-[#6366f1]/10 border border-[#6366f1]/20 text-[#818cf8] hover:bg-[#6366f1]/20 disabled:opacity-30 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
