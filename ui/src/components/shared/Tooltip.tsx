import { useState, useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';

interface TooltipProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  iconOnly?: boolean;
}

export function Tooltip({ title, description, children, placement = 'top' }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);

  const show = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(true), 150);
  };

  const hide = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setOpen(false), 100);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const placementClasses = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  };

  return (
    <div
      ref={triggerRef}
      className="relative inline-flex items-center"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children ? (
        <span className="cursor-help">{children}</span>
      ) : (
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md p-0.5 transition-colors"
          style={{ color: 'var(--theme-ink-soft)' }}
          onMouseOver={(e) => (e.currentTarget.style.color = 'var(--theme-accent)')}
          onMouseOut={(e) => (e.currentTarget.style.color = 'var(--theme-ink-soft)')}
          aria-label={`Help: ${title}`}
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      )}

      {open && (
        <div className={`absolute z-50 w-64 ${placementClasses[placement]}`} role="tooltip">
          <div
            className="titan-menu-surface px-3 py-2.5"
            style={{ borderRadius: 6 }}
          >
            <p
              className="text-xs font-semibold mb-0.5"
              style={{ color: 'var(--theme-ink)', fontFamily: 'var(--theme-font-display)' }}
            >
              {title}
            </p>
            {description && (
              <p
                className="text-[11px] leading-relaxed"
                style={{ color: 'var(--theme-ink-soft)', fontFamily: 'var(--theme-font-display)' }}
              >
                {description}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Inline help badge for section headers — combines an icon + tooltip */
export function HelpBadge({ title, description }: { title: string; description: string }) {
  return (
    <Tooltip title={title} description={description}>
      <HelpCircle
        className="w-3.5 h-3.5 transition-colors"
        style={{ color: 'var(--theme-ink-soft)' }}
      />
    </Tooltip>
  );
}
