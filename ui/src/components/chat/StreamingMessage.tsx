import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ToolCallIndicator } from './ToolCallIndicator';

interface StreamingMessageProps {
  content: string;
  activeTools: string[];
}

export function StreamingMessage({ content, activeTools }: StreamingMessageProps) {
  return (
    <div className="flex justify-start mb-4">
      <div className="max-w-full w-full">
        {activeTools.length > 0 && <ToolCallIndicator tools={activeTools} />}

        <div className="bg-bg-tertiary text-text px-4 py-3 rounded-2xl rounded-bl-md text-sm leading-relaxed prose prose-invert prose-sm max-w-none [&_pre]:bg-bg-secondary [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:text-accent-hover [&_a]:text-accent-hover">
          {content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {content}
            </ReactMarkdown>
          ) : (
            <span className="text-text-secondary italic">Thinking...</span>
          )}
          <span className="inline-block w-2 h-4 bg-text ml-0.5 animate-pulse rounded-sm" />
        </div>
      </div>
    </div>
  );
}
