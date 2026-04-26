import { useState, useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';

interface TooltipProps {
  title: string;
  description?: string;
  children?: React.ReactNode;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  iconOnly?: boolean;
}

export function Tooltip({ title, description, children, placement = 'top', iconOnly = false }: TooltipProps) {
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

  const arrowClasses = {
    top: 'top-full left-1/2 -translate-x-1/2 -mt-1 border-l-transparent border-r-transparent border-b-transparent',
    bottom: 'bottom-full left-1/2 -translate-x-1/2 -mb-1 border-l-transparent border-r-transparent border-t-transparent',
    left: 'left-full top-1/2 -translate-y-1/2 -ml-1 border-t-transparent border-b-transparent border-r-transparent',
    right: 'right-full top-1/2 -translate-y-1/2 -mr-1 border-t-transparent border-b-transparent border-l-transparent',
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
          className="inline-flex items-center justify-center text-text-muted hover:text-accent transition-colors rounded-md p-0.5"
          aria-label={`Help: ${title}`}
        >
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
      )}

      {open && (
        <div
          className={`absolute z-50 w-64 ${placementClasses[placement]}`}
          role="tooltip"
        >
          <div className="rounded-lg border border-border bg-bg-secondary px-3 py-2.5 shadow-xl">
            <p className="text-xs font-semibold text-text mb-0.5">{title}</p>
            {description && (
              <p className="text-[11px] text-text-secondary leading-relaxed">{description}</p>
            )}
          </div>
          {/* Arrow */}
          <div
            className={`absolute w-2 h-2 border-4 border-bg-secondary ${arrowClasses[placement]}`}
            aria-hidden="true"
          />
        </div>
      )}
    </div>
  );
}

/** Inline help badge for section headers — combines an icon + tooltip */
export function HelpBadge({ title, description }: { title: string; description: string }) {
  return (
    <Tooltip title={title} description={description}>
      <HelpCircle className="w-3.5 h-3.5 text-text-muted hover:text-accent transition-colors" />
    </Tooltip>
  );
}
