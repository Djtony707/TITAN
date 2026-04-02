import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from './Input';

interface SearchInputProps {
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  debounceMs?: number;
  className?: string;
  autoFocus?: boolean;
}

export function SearchInput({ value: controlled, onChange, placeholder = 'Search...', debounceMs = 200, className, autoFocus }: SearchInputProps) {
  const [local, setLocal] = useState(controlled ?? '');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (controlled !== undefined) setLocal(controlled);
  }, [controlled]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setLocal(v);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => onChange(v), debounceMs);
    },
    [onChange, debounceMs],
  );

  const handleClear = useCallback(() => {
    setLocal('');
    onChange('');
  }, [onChange]);

  return (
    <div className={`relative ${className ?? ''}`}>
      <Input
        icon={<Search size={16} />}
        value={local}
        onChange={handleChange}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      {local && (
        <button
          onClick={handleClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text rounded"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
