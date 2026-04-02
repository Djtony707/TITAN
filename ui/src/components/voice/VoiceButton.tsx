import { Mic } from 'lucide-react';

interface VoiceButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export function VoiceButton({ onClick, disabled = false }: VoiceButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Voice services not available' : 'Voice chat'}
      className={`
        relative rounded-full p-2.5 transition-all duration-200
        ${disabled
          ? 'bg-bg-tertiary/50 text-text-muted cursor-not-allowed'
          : 'bg-bg-tertiary text-text-secondary hover:bg-accent hover:text-text cursor-pointer'
        }
      `}
    >
      <Mic className="h-5 w-5" />
      {!disabled && (
        <span
          className="absolute inset-0 rounded-full"
          style={{
            animation: 'voicePulse 2s ease-in-out infinite',
            border: '1px solid #6366f1',
            opacity: 0,
          }}
        />
      )}
      <style>{`
        @keyframes voicePulse {
          0%, 100% { opacity: 0; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(1.15); }
        }
      `}</style>
    </button>
  );
}
