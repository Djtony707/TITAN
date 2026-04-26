import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { AgentEvent, ToolInvocation } from '@/api/types';
import { Brain, Loader, Bot } from 'lucide-react';
import { ToolInvocationTimeline } from './ToolInvocationTimeline';

interface StreamingMessageProps {
  content: string;
  activeTools: string[];
  agentEvents?: AgentEvent[];
  toolInvocations?: ToolInvocation[];
}

export function StreamingMessage({ content, activeTools, agentEvents = [], toolInvocations = [] }: StreamingMessageProps) {
  // Show tool timeline if we have structured invocations, otherwise fall back to legacy event display
  const hasStructuredTools = toolInvocations.length > 0;

  return (
    <div className="flex justify-start mb-5">
      <div className="max-w-full w-full md:max-w-[85%]">
        <div className="flex items-end gap-2 mb-1">
          <div className="w-5 h-5 rounded-full bg-bg-tertiary border border-border flex items-center justify-center">
            <Bot size={12} className="text-accent-light" />
          </div>
          <span className="text-[10px] font-medium text-text-secondary">TITAN</span>
        </div>

        {/* Tool invocation timeline */}
        {hasStructuredTools && (
          <ToolInvocationTimeline invocations={toolInvocations} maxPreview={6} />
        )}

        {/* Legacy activity feed (for initiatives or when no structured tools) */}
        {!hasStructuredTools && agentEvents.length > 0 && (
          <div className="mb-2 space-y-1 bg-bg-secondary/50 border border-border/50 rounded-xl px-3 py-2">
            {agentEvents.slice(-4).map((evt, i) => {
              if (evt.type === 'round') {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-[10px] text-text-muted">
                    Round {evt.round}/{evt.maxRounds}
                  </div>
                );
              }
              if (evt.type === 'thinking') {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-accent-hover">
                    <Brain size={12} className="animate-pulse" />
                    <span>Thinking...</span>
                  </div>
                );
              }
              if (evt.type === 'tool_start') {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-cyan">
                    <Loader size={12} className="animate-spin" />
                    <span>{evt.toolName}</span>
                  </div>
                );
              }
              if (evt.type === 'tool_end') {
                return (
                  <div key={i} className="flex items-center gap-1.5 text-xs text-text-secondary">
                    <span>{evt.status === 'success' ? '✓' : '✗'}</span>
                    <span>{evt.toolName}</span>
                    {evt.durationMs && <span className="text-text-muted text-[10px]">{evt.durationMs}ms</span>}
                  </div>
                );
              }
              return null;
            })}
          </div>
        )}

        {/* Streaming content */}
        <div className="bg-bg-tertiary border border-border/50 text-text px-4 py-3 rounded-2xl rounded-bl-sm text-sm leading-relaxed shadow-sm prose prose-invert prose-sm max-w-none [&_pre]:bg-bg-secondary [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:border [&_pre]:border-border [&_code]:text-accent-hover [&_a]:text-accent-hover">
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
