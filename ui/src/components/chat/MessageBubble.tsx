import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { ChatMessage } from '@/api/types';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

function formatTimestamp(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const MODEL_NAMES: Record<string, string> = {
  // Local Ollama
  'qwen3.5:35b': 'Qwen 3.5 35B',
  'qwen3:30b': 'Qwen 3 30B',
  'qwen3:0.6b': 'Qwen 3 0.6B',
  'devstral-small-2': 'Devstral Small 2',
  'devstral-small-2:latest': 'Devstral Small 2',
  'llama3.3:70b': 'Llama 3.3 70B',
  'llama3.1:8b': 'Llama 3.1 8B',
  'mistral:7b': 'Mistral 7B',
  'mixtral:8x7b': 'Mixtral 8x7B',
  // Ollama Cloud
  'deepseek-v3.1:671b-cloud': 'DeepSeek V3.1 671B ☁',
  'deepseek-v3.2:671b-cloud': 'DeepSeek V3.2 671B ☁',
  'glm-5:cloud': 'GLM-5 744B ☁',
  'kimi-k2.5:cloud': 'Kimi K2.5 ☁',
  'qwen3-coder-next:cloud': 'Qwen3 Coder 480B ☁',
  'qwen3.5:397b-cloud': 'Qwen 3.5 397B ☁',
  'devstral-2:cloud': 'Devstral 2 123B ☁',
  'nemotron-3-super:cloud': 'Nemotron 3 Super ☁',
  'gemini-3-flash-preview:latest': 'Gemini 3 Flash ☁',
  'gpt-oss:120b-cloud': 'GPT OSS 120B ☁',
  // Anthropic
  'claude-sonnet-4-20250514': 'Claude Sonnet 4',
  'claude-opus-4-20250514': 'Claude Opus 4',
  'claude-haiku-4-20250514': 'Claude Haiku 4',
  'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
  'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku',
  // OpenAI
  'gpt-4o': 'GPT-4o',
  'gpt-4o-mini': 'GPT-4o Mini',
  'gpt-4-turbo': 'GPT-4 Turbo',
  'o1': 'o1',
  'o3-mini': 'o3-mini',
  // Google
  'gemini-2.0-flash': 'Gemini 2.0 Flash',
  'gemini-1.5-pro': 'Gemini 1.5 Pro',
};

function friendlyModel(model?: string): string {
  if (!model) return '';
  // Strip provider prefix: "ollama/qwen3.5:35b" → "qwen3.5:35b"
  const bare = model.includes('/') ? model.split('/').slice(1).join('/') : model;
  return MODEL_NAMES[bare] ?? bare;
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="max-w-[80%]">
          <div className="bg-[#6366f1] text-[#fafafa] px-4 py-3 rounded-2xl rounded-br-md whitespace-pre-wrap text-sm leading-relaxed">
            {message.content}
          </div>
          {message.timestamp && (
            <p className="text-[#71717a] text-[11px] mt-1 text-right">
              {formatTimestamp(message.timestamp)}
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-full w-full">
        <div className="bg-[#27272a] text-[#fafafa] px-4 py-3 rounded-2xl rounded-bl-md text-sm leading-relaxed prose prose-invert prose-sm max-w-none [&_pre]:bg-[#18181b] [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:text-[#818cf8] [&_a]:text-[#818cf8]">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {message.content}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-2 h-4 bg-[#fafafa] ml-0.5 animate-pulse rounded-sm" />
          )}
        </div>

        {message.toolsUsed && message.toolsUsed.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {message.toolsUsed.map((tool) => (
              <span
                key={tool}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#3f3f46] text-[#a1a1aa]"
              >
                {tool}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 mt-1">
          {message.timestamp && (
            <span className="text-[#71717a] text-[11px]">
              {formatTimestamp(message.timestamp)}
            </span>
          )}
          {message.model && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#3f3f46] text-[#a1a1aa]">
              {friendlyModel(message.model)}
            </span>
          )}
          {message.durationMs != null && message.durationMs > 0 && (
            <span className="text-[#71717a] text-[11px]">
              {formatDuration(message.durationMs)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
