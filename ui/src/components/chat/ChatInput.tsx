import { useState, useRef, useCallback, type KeyboardEvent, type ChangeEvent } from 'react';
import { ArrowUp, Plus, Square } from 'lucide-react';
import { MiniFluidBubble } from './MiniFluidBubble';

interface ChatInputProps {
  onSend: (message: string) => void;
  onStop?: () => void;
  disabled?: boolean;
  voiceAvailable?: boolean;
  onVoiceClick?: () => void;
}

export function ChatInput({ onSend, onStop, disabled, voiceAvailable, onVoiceClick }: ChatInputProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 24;
    const maxHeight = lineHeight * 6;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, []);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    adjustHeight();
  };

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, disabled, onSend]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div className="sticky bottom-0 bg-gradient-to-t from-[#09090b] via-[#09090b] to-transparent pt-4 md:pt-6 pb-3 md:pb-4 px-3 md:px-4">
      <div className="max-w-3xl mx-auto">
        <div className="relative flex items-end gap-1.5 md:gap-2 rounded-2xl border border-border bg-bg-secondary px-2 md:px-2 py-2 md:py-2 transition-all focus-within:border-border-light focus-within:shadow-[0_0_0_1px_rgba(99,102,241,0.15)]">
          {/* Attach button — hidden on mobile to save space, visible on md+ */}
          <button
            type="button"
            className="hidden md:flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-secondary"
            aria-label="Attach file"
            title="Attach file"
          >
            <Plus className="h-5 w-5" />
          </button>

          {/* Textarea with better mobile sizing */}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything..."
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none bg-transparent py-1.5 md:py-1.5 text-sm leading-6 text-text placeholder-border-light outline-none scrollbar-thin max-h-36 min-h-[36px] touch-manipulation"
          />

          {/* Action buttons */}
          <div className="flex items-center gap-0.5 md:gap-1 shrink-0">
            {/* Voice button */}
            <MiniFluidBubble
              size={32}
              disabled={!voiceAvailable}
              onClick={onVoiceClick}
            />

            {/* Send / Stop button — larger touch target */}
            <button
              type="button"
              onClick={disabled ? onStop : handleSend}
              disabled={!canSend && !disabled}
              className={`flex h-9 w-9 md:h-9 md:w-9 items-center justify-center rounded-xl transition-all active:scale-95 md:hover:scale-105 ${
                disabled
                  ? 'bg-text text-[#09090b]'
                  : canSend
                    ? 'bg-text text-[#09090b] active:bg-[#e4e4e7] md:hover:bg-[#e4e4e7]'
                    : 'bg-bg-tertiary text-text-muted cursor-not-allowed'
              }`}
              aria-label={disabled ? 'Stop' : 'Send'}
            >
              {disabled ? (
                <Square className="h-4 w-4" />
              ) : (
                <ArrowUp className="h-5 w-5" strokeWidth={2.5} />
              )}
            </button>
          </div>
        </div>

        {/* Footer hint */}
        <p className="mt-1.5 md:mt-2 text-center text-[10px] md:text-[10px] text-border">
          TITAN can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  );
}
