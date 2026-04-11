import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { AgentEvent } from '@/api/types';
import { Wrench, Brain, CheckCircle, XCircle, Loader, ChevronRight } from 'lucide-react';

interface StreamingMessageProps {
  content: string;
  activeTools: string[];
  agentEvents?: AgentEvent[];
}

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Reading file',
  write_file: 'Writing file',
  edit_file: 'Editing file',
  append_file: 'Appending to file',
  list_dir: 'Listing directory',
  shell: 'Running command',
  web_search: 'Searching web',
  web_fetch: 'Fetching URL',
  weather: 'Checking weather',
  memory: 'Accessing memory',
  spawn_agent: 'Spawning sub-agent',
  tool_search: 'Discovering tools',
};

function getToolLabel(name: string): string {
  return TOOL_LABELS[name] || name.replace(/_/g, ' ');
}

function formatArgs(args?: Record<string, unknown>): string | null {
  if (!args) return null;
  const path = args.path || args.file_path || args.directory || args.url || args.query || args.command;
  if (typeof path === 'string') return path.length > 60 ? '...' + path.slice(-55) : path;
  return null;
}

export function StreamingMessage({ content, activeTools, agentEvents = [] }: StreamingMessageProps) {
  // Build activity log from events
  const toolEvents = agentEvents.filter(e => e.type === 'tool_start' || e.type === 'tool_end' || e.type === 'round' || e.type === 'thinking');

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-full w-full">
        {/* Live activity feed — shows what TITAN is doing right now */}
        {toolEvents.length > 0 && (
          <div className="mb-2 space-y-0.5">
            {toolEvents.map((evt, i) => {
              if (evt.type === 'round') {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-[10px] text-text-muted py-0.5">
                    <ChevronRight size={10} />
                    Round {evt.round}/{evt.maxRounds}
                  </div>
                );
              }
              if (evt.type === 'thinking') {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-accent-hover py-0.5">
                    <Brain size={12} className="animate-pulse" />
                    <span>Thinking...</span>
                  </div>
                );
              }
              if (evt.type === 'tool_start') {
                const isActive = activeTools.includes(evt.toolName || '');
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs py-0.5">
                    {isActive ? (
                      <Loader size={12} className="text-cyan animate-spin" />
                    ) : (
                      <Wrench size={12} className="text-text-muted" />
                    )}
                    <span className={isActive ? 'text-cyan' : 'text-text-secondary'}>
                      {getToolLabel(evt.toolName || '')}
                    </span>
                    {evt.args && (
                      <span className="text-text-muted font-mono text-[10px] truncate max-w-[250px]">
                        {formatArgs(evt.args as Record<string, unknown>)}
                      </span>
                    )}
                  </div>
                );
              }
              if (evt.type === 'tool_end') {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs py-0.5">
                    {evt.status === 'success' ? (
                      <CheckCircle size={12} className="text-success" />
                    ) : (
                      <XCircle size={12} className="text-error" />
                    )}
                    <span className="text-text-secondary">
                      {getToolLabel(evt.toolName || '')}
                    </span>
                    {evt.durationMs && (
                      <span className="text-text-muted text-[10px]">{evt.durationMs}ms</span>
                    )}
                  </div>
                );
              }
              return null;
            })}
          </div>
        )}

        {/* Streaming content */}
        <div className="bg-bg-tertiary text-text px-4 py-3 rounded-2xl rounded-bl-md text-sm leading-relaxed prose prose-invert prose-sm max-w-none [&_pre]:bg-bg-secondary [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:text-accent-hover [&_a]:text-accent-hover">
          {content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {content}
            </ReactMarkdown>
          ) : activeTools.length > 0 ? (
            <span className="text-text-secondary italic flex items-center gap-2">
              <Loader size={14} className="animate-spin text-accent" />
              Working...
            </span>
          ) : (
            <span className="text-text-secondary italic flex items-center gap-2">
              <Brain size={14} className="animate-pulse text-accent" />
              Thinking...
            </span>
          )}
          <span className="inline-block w-2 h-4 bg-text ml-0.5 animate-pulse rounded-sm" />
        </div>
      </div>
    </div>
  );
}
