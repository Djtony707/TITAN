import { useState, useEffect, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, Brain, Terminal, Search, FileText, Database, Code, ChevronDown } from 'lucide-react';
import type { AgentEvent } from '@/api/types';

const TOOL_ICONS: Record<string, typeof Terminal> = {
  shell: Terminal,
  web_search: Search,
  read_file: FileText,
  write_file: FileText,
  edit_file: FileText,
  list_dir: FileText,
  memory: Database,
  graph_search: Database,
  code_exec: Code,
};

const TOOL_COLORS: Record<string, string> = {
  shell: '#22d3ee',
  web_search: '#a78bfa',
  read_file: '#34d399',
  write_file: '#34d399',
  edit_file: '#34d399',
  memory: '#f59e0b',
  graph_search: '#f59e0b',
  code_exec: '#6366f1',
  weather: '#22d3ee',
};

interface ToolCard {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  result?: string;
  status: 'running' | 'success' | 'error';
  startTime: number;
  durationMs?: number;
}

export function ActivityCards({ events }: { events: AgentEvent[] }) {
  const [cards, setCards] = useState<ToolCard[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [currentRound, setCurrentRound] = useState(0);
  const [isThinking, setIsThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    for (const evt of events) {
      if (evt.type === 'tool_start' && evt.toolName) {
        const card: ToolCard = {
          id: evt.id,
          name: evt.toolName,
          args: evt.args,
          status: 'running',
          startTime: evt.timestamp,
        };
        setCards((prev) => {
          if (prev.some((c) => c.id === evt.id)) return prev;
          return [...prev, card];
        });
        setExpandedId(evt.id);
        setIsThinking(false);
      } else if (evt.type === 'tool_end' && evt.toolName) {
        setCards((prev) =>
          prev.map((c) =>
            c.name === evt.toolName && c.status === 'running'
              ? { ...c, status: evt.status === 'error' ? 'error' : 'success', result: evt.result, durationMs: evt.durationMs }
              : c
          )
        );
        setExpandedId(null);
      } else if (evt.type === 'thinking') {
        setIsThinking(true);
      } else if (evt.type === 'round') {
        setCurrentRound(evt.round || 0);
      } else if (evt.type === 'done') {
        setIsThinking(false);
      }
    }
  }, [events]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [cards, isThinking]);

  const getIcon = (card: ToolCard) => {
    if (card.status === 'running') return <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#6366f1' }} />;
    if (card.status === 'error') return <XCircle className="w-4 h-4" style={{ color: '#ef4444' }} />;
    return <CheckCircle2 className="w-4 h-4" style={{ color: '#22c55e' }} />;
  };

  const getToolIcon = (name: string) => {
    const Icon = TOOL_ICONS[name] || Terminal;
    const color = TOOL_COLORS[name] || '#a1a1aa';
    return <Icon className="w-3.5 h-3.5" style={{ color }} />;
  };

  const getBorderColor = (card: ToolCard) => {
    if (card.status === 'running') return '#6366f1';
    if (card.status === 'error') return '#ef4444';
    return '#22c55e';
  };

  if (cards.length === 0 && !isThinking) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-text-muted">
        <Brain className="w-8 h-8 mb-2 opacity-30" />
        <p className="text-xs">Waiting for agent activity...</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-3 space-y-2">
      {/* Round indicator */}
      {currentRound > 0 && (
        <div className="flex items-center gap-2 text-xs text-text-muted px-1">
          <div className="h-px flex-1 bg-border" />
          <span>Round {currentRound}</span>
          <div className="h-px flex-1 bg-border" />
        </div>
      )}

      {/* Waterfall timeline */}
      {cards.length > 1 && (
        <div className="bg-bg-secondary rounded-lg border border-border p-2 mb-2">
          <div className="flex gap-0.5 h-3 rounded overflow-hidden">
            {cards.map((card) => {
              const duration = card.durationMs || (card.status === 'running' ? Date.now() - card.startTime : 500);
              const totalDuration = cards.reduce((sum, c) => sum + (c.durationMs || 500), 0);
              const width = Math.max(5, (duration / totalDuration) * 100);
              return (
                <div
                  key={card.id}
                  className="rounded-sm transition-all duration-300"
                  style={{
                    width: `${width}%`,
                    backgroundColor: TOOL_COLORS[card.name] || '#6366f1',
                    opacity: card.status === 'running' ? 0.6 : 0.9,
                  }}
                  title={`${card.name}: ${card.durationMs || '...'}ms`}
                />
              );
            })}
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[10px] text-text-muted">{cards.length} tools</span>
            <span className="text-[10px] text-text-muted">
              {cards.reduce((sum, c) => sum + (c.durationMs || 0), 0)}ms total
            </span>
          </div>
        </div>
      )}

      {/* Tool cards */}
      {cards.map((card) => {
        const isExpanded = expandedId === card.id || card.status === 'running' || card.status === 'error';
        return (
          <div
            key={card.id}
            className="bg-bg-secondary rounded-lg border border-border overflow-hidden transition-all duration-300"
            style={{ borderLeftWidth: 3, borderLeftColor: getBorderColor(card) }}
          >
            {/* Header */}
            <button
              onClick={() => setExpandedId(isExpanded ? null : card.id)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-bg-tertiary transition-colors duration-200"
            >
              {getIcon(card)}
              {getToolIcon(card.name)}
              <span className="text-sm font-medium text-text flex-1 text-left">{card.name}</span>
              {card.durationMs !== undefined && (
                <span className="text-xs bg-bg-tertiary rounded-full px-2 py-0.5 text-text-secondary">
                  {card.durationMs}ms
                </span>
              )}
              <ChevronDown
                className="w-3.5 h-3.5 text-text-muted transition-transform duration-200"
                style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)' }}
              />
            </button>

            {/* Expanded content */}
            <div
              className="transition-all duration-300 overflow-hidden"
              style={{ maxHeight: isExpanded ? '300px' : '0', opacity: isExpanded ? 1 : 0 }}
            >
              <div className="px-3 pb-3 space-y-2">
                {card.args && Object.keys(card.args).length > 0 && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-text-muted">Input</span>
                    <pre className="mt-1 text-xs font-mono text-text-secondary bg-bg rounded-md p-2 overflow-x-auto max-h-20 overflow-y-auto">
                      {JSON.stringify(card.args, null, 2)}
                    </pre>
                  </div>
                )}
                {card.result && (
                  <div>
                    <span className="text-[10px] uppercase tracking-wider text-text-muted">Output</span>
                    <pre className="mt-1 text-xs font-mono text-text-secondary bg-bg rounded-md p-2 overflow-x-auto max-h-20 overflow-y-auto whitespace-pre-wrap">
                      {card.result}
                    </pre>
                  </div>
                )}
                {card.status === 'running' && (
                  <div className="flex items-center gap-2 text-xs text-accent">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span>Executing...</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Thinking indicator */}
      {isThinking && (
        <div className="flex items-center gap-2 px-3 py-2 bg-bg-secondary rounded-lg border border-border" style={{ borderLeftWidth: 3, borderLeftColor: '#f59e0b' }}>
          <Brain className="w-4 h-4 animate-pulse" style={{ color: '#f59e0b' }} />
          <span className="text-sm text-text-secondary">Thinking...</span>
          <div className="flex gap-1 ml-auto">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="w-1.5 h-1.5 rounded-full bg-warning animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
