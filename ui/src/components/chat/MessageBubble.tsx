import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '@/api/types';
import { User, Bot } from 'lucide-react';
import { ToolInvocationTimeline } from './ToolInvocationTimeline';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

function formatTimestamp(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const MODEL_NAMES: Record<string, string> = {
  'qwen3.5:35b': 'Qwen 3.5 35B',
  'qwen3:30b': 'Qwen 3 30B',
  'qwen3:0.6b': 'Qwen 3 0.6B',
  'devstral-small-2': 'Devstral Small 2',
  'devstral-small-2:latest': 'Devstral Small 2',
  'llama3.3:70b': 'Llama 3.3 70B',
  'llama3.1:8b': 'Llama 3.1 8B',
  'mistral:7b': 'Mistral 7B',
  'mixtral:8x7b': 'Mixtral 8x7B',
  'deepseek-v3.1:671b-cloud': 'DeepSeek V3.1 671B ☁',
  'deepseek-v3.2:671b-cloud': 'DeepSeek V3.2 671B ☁',
  'glm-5:cloud': 'GLM-5 744B ☁',
  'kimi-k2.5:cloud': 'Kimi K2.5 ☁',
  'kimi-k2.6:cloud': 'Kimi K2.6 ☁',
  'qwen3-coder-next:cloud': 'Qwen3 Coder 480B ☁',
  'qwen3.5:397b-cloud': 'Qwen 3.5 397B ☁',
  'devstral-2:cloud': 'Devstral 2 123B ☁',
  'nemotron-3-super:cloud': 'Nemotron 3 Super ☁',
  'gemini-3-flash-preview:latest': 'Gemini 3 Flash ☁',
  'gpt-oss:120b-cloud': 'GPT OSS 120B ☁',
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-opus-4-20250514': 'Claude Opus 4',
  'claude-haiku-4-20250514': 'Claude Haiku 4',
  'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
  'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4-turbo': 'GPT-4 Turbo',
  'o1': 'o1',
  'o3-mini': 'o3-mini',
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
  'gemini-1.5-pro': 'Gemini 1.5 Pro',
};

function friendlyModel(model?: string): string {
  if (!model) return 'TITAN';
  const bare = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  return MODEL_NAMES[bare] ?? bare;
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end mb-5 group">
        <div className="max-w-[85%] md:max-w-[75%]">
          <div className="flex items-end gap-2 justify-end mb-1">
            <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
              {formatTimestamp(message.timestamp)}
            </span>
            <span className="text-[10px] font-medium text-text-secondary">You</span>
            <div className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center">
              <User size={12} className="text-accent-light" />
            </div>
          </div>
          <div className="bg-accent text-text px-4 py-3 rounded-2xl rounded-br-sm whitespace-pre-wrap text-sm leading-relaxed shadow-sm">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-5 group">
      <div className="max-w-full w-full md:max-w-[85%]">
        <div className="flex items-end gap-2 mb-1">
          <div className="w-5 h-5 rounded-full bg-bg-tertiary border border-border flex items-center justify-center">
            <Bot size={12} className="text-accent-light" />
          </div>
          <span className="text-[10px] font-medium text-text-secondary">
            {friendlyModel(message.model)}
          </span>
          <span className="text-[10px] text-text-muted opacity-0 group-hover:opacity-100 transition-opacity">
            {formatTimestamp(message.timestamp)}
          </span>
        </div>

        <div className="bg-bg-tertiary border border-border/50 text-text px-4 py-3 rounded-2xl rounded-bl-sm text-sm leading-relaxed shadow-sm prose prose-invert prose-sm max-w-none [&_pre]:bg-bg-secondary [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:border [&_pre]:border-border [&_code]:text-accent-hover [&_a]:text-accent-hover">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {message.content}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-2 h-4 bg-text ml-0.5 animate-pulse rounded-sm" />
          )}
        </div>

        {message.toolInvocations && message.toolInvocations.length > 0 && (
          <ToolInvocationTimeline invocations={message.toolInvocations} maxPreview={3} />
        )}

        {(!message.toolInvocations || message.toolInvocations.length === 0) && message.toolsUsed && message.toolsUsed.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.toolsUsed.map((tool) => (
              <span
                key={tool}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-bg-tertiary border border-border text-text-secondary"
              >
                {tool}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 mt-1.5">
          {message.durationMs != null && message.durationMs > 0 && (
            <span className="text-text-muted text-[10px]">
              {formatDuration(message.durationMs)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
