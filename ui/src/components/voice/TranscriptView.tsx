import { useEffect, useRef } from 'react';

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface TranscriptViewProps {
  messages?: TranscriptMessage[];
  isListening?: boolean;
}

export function TranscriptView({ messages = [], isListening = false }: TranscriptViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  return (
    <div
      ref={scrollRef}
      className="w-full max-w-lg overflow-y-auto rounded-xl backdrop-blur"
      style={{
        maxHeight: 300,
        backgroundColor: 'rgba(24, 24, 27, 0.5)',
        padding: '1rem',
      }}
    >
      {messages.length === 0 && !isListening && (
        <p className="text-center text-sm text-text-muted">
          Start speaking to begin the conversation
        </p>
      )}
      <div className="flex flex-col gap-2">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className="max-w-[80%] rounded-lg px-3 py-2 text-sm"
              style={{
                backgroundColor: msg.role === 'user' ? 'var(--color-accent)' : 'var(--color-bg-tertiary)',
                color: 'var(--color-text)',
              }}
            >
              {msg.text}
            </div>
          </div>
        ))}
      </div>
      {isListening && (
        <div className="mt-3 flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              backgroundColor: 'var(--color-accent)',
              animation: 'listeningPulse 1s ease-in-out infinite',
            }}
          />
          <span className="text-xs text-text-secondary">
            Listening...
          </span>
          <style>{`
            @keyframes listeningPulse {
              0%, 100% { opacity: 1; transform: scale(1); }
              50% { opacity: 0.4; transform: scale(0.8); }
            }
          `}</style>
        </div>
      )}
    </div>
  );
}
