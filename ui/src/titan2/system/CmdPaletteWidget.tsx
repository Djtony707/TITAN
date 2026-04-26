/**
 * Titan 3.0 Command Palette Widget
 * Raycast-style CMD+K overlay for spaces, widgets, and actions.
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { SpaceEngine } from '../canvas/SpaceEngine';
import { Search, X, Home, Brain, Terminal, Network, Server, Wrench, Settings, FileText, LayoutGrid, MessageSquare, Database, Mic, Activity, BookOpen, FlaskConical, GitPullRequest, Eye, Clock, Archive, Cpu, Users, Shield, Radio, Globe, Paperclip as PaperclipIcon, TestTube, Save } from 'lucide-react';

interface Props {
  currentSpaceId: string;
  onSpaceSelect: (id: string) => void;
  onAction: (action: { type: 'widget'; source: string; name: string; w?: number; h?: number }) => void;
  onClose: () => void;
}

const ACTIONS = [
  { type: 'widget' as const, source: 'system:nav', name: 'Nav Widget', w: 3, h: 4, icon: <LayoutGrid className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:chat', name: 'Chat Widget', w: 4, h: 5, icon: <MessageSquare className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:soma', name: 'SOMA', w: 6, h: 6, icon: <Brain className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:command-post', name: 'Command Post', w: 8, h: 6, icon: <Terminal className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:intelligence', name: 'Intelligence', w: 6, h: 5, icon: <Network className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:memory-graph', name: 'Memory Graph', w: 8, h: 7, icon: <Database className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:voice', name: 'Voice', w: 5, h: 5, icon: <Mic className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:infra', name: 'Infrastructure', w: 6, h: 4, icon: <Server className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:tools', name: 'Tools', w: 5, h: 4, icon: <Wrench className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:settings', name: 'Settings', w: 5, h: 5, icon: <Settings className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:files', name: 'Files', w: 4, h: 6, icon: <FileText className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:daemon', name: 'Daemon', w: 6, h: 6, icon: <Activity className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:memory-wiki', name: 'Memory Wiki', w: 6, h: 6, icon: <BookOpen className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:autoresearch', name: 'Autoresearch', w: 6, h: 6, icon: <FlaskConical className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:self-proposals', name: 'Self-Proposals', w: 6, h: 6, icon: <GitPullRequest className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:overview', name: 'Overview', w: 6, h: 5, icon: <Eye className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:sessions', name: 'Sessions', w: 6, h: 5, icon: <Clock className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:watch', name: 'Watch', w: 8, h: 7, icon: <Activity className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:backup', name: 'Backup Manager', w: 6, h: 6, icon: <Archive className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:training', name: 'Training Dashboard', w: 6, h: 6, icon: <Brain className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:recipes', name: 'Recipe Kitchen', w: 6, h: 6, icon: <BookOpen className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:vram', name: 'VRAM Monitor', w: 6, h: 6, icon: <Cpu className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:teams', name: 'Team Hub', w: 6, h: 6, icon: <Users className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:cron', name: 'Cron Scheduler', w: 6, h: 6, icon: <Clock className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:checkpoints', name: 'Checkpoints', w: 6, h: 5, icon: <Save className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:organism', name: 'Organism Monitor', w: 6, h: 6, icon: <Shield className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:fleet', name: 'Fleet Router', w: 6, h: 5, icon: <Radio className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:browser', name: 'Browser Tools', w: 6, h: 5, icon: <Globe className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:paperclip', name: 'Paperclip', w: 6, h: 5, icon: <PaperclipIcon className="w-4 h-4" /> },
  { type: 'widget' as const, source: 'system:eval', name: 'Test Lab', w: 6, h: 6, icon: <TestTube className="w-4 h-4" /> },
];

export function CmdPaletteWidget({ currentSpaceId, onSpaceSelect, onAction, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const spaces = SpaceEngine.list();

  const items = useMemo(() => {
    const q = query.toLowerCase();
    const spaceItems = spaces
      .filter(s => s.id !== currentSpaceId && s.name.toLowerCase().includes(q))
      .map(s => ({ type: 'space' as const, id: s.id, name: s.name, color: s.color }));
    const actionItems = ACTIONS
      .filter(a => a.name.toLowerCase().includes(q))
      .map(a => ({ type: 'action' as const, action: a, name: a.name }));
    return [...spaceItems, ...actionItems];
  }, [query, spaces, currentSpaceId]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, items.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const item = items[selectedIndex];
        if (!item) return;
        if (item.type === 'space') onSpaceSelect(item.id);
        if (item.type === 'action') onAction(item.action);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [items, selectedIndex, onSpaceSelect, onAction, onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh]" onClick={onClose}>
      <div className="w-full max-w-lg bg-[#18181b]/98 backdrop-blur-xl border border-[#27272a]/60 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#27272a]/40">
          <Search className="w-4 h-4 text-[#3f3f46]" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search spaces, widgets, actions..."
            className="flex-1 bg-transparent text-sm text-[#e4e4e7] placeholder:text-[#3f3f46] outline-none"
          />
          <button onClick={onClose} className="text-[#3f3f46] hover:text-[#71717a]">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-auto py-1">
          {items.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-[#52525b]">
              No results for "{query}"
            </div>
          )}
          {items.map((item, idx) => (
            <button
              key={item.type === 'space' ? item.id : item.action.source}
              onClick={() => {
                if (item.type === 'space') onSpaceSelect(item.id);
                if (item.type === 'action') onAction(item.action);
              }}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                idx === selectedIndex ? 'bg-[#6366f1]/10 text-[#818cf8]' : 'text-[#a1a1aa] hover:bg-[#27272a]/30'
              }`}
            >
              {item.type === 'space' ? (
                <div className="w-4 h-4 rounded-full" style={{ background: item.color || '#52525b' }} />
              ) : (
                <span className="text-[#6366f1]/60">{item.action.icon}</span>
              )}
              <span className="text-sm">{item.name}</span>
              <span className="ml-auto text-[10px] text-[#3f3f46] uppercase tracking-wider">
                {item.type === 'space' ? 'Space' : 'Widget'}
              </span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[#27272a]/40 flex items-center gap-3 text-[10px] text-[#3f3f46]">
          <span>↑↓ Navigate</span>
          <span>↵ Select</span>
          <span>ESC Close</span>
        </div>
      </div>
    </div>
  );
}
