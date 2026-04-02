import { useState } from 'react';
import { ClipboardCopy, Check } from 'lucide-react';

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative rounded-lg border border-border bg-bg">
      {language && (
        <div className="border-b border-border px-4 py-1.5 text-xs text-text-muted">
          {language}
        </div>
      )}
      <button
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded-md p-1.5 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text"
      >
        {copied ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
      </button>
      <pre className="overflow-x-auto p-4">
        <code className="font-mono text-sm text-text">{code}</code>
      </pre>
    </div>
  );
}
