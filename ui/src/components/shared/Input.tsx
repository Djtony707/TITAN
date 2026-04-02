import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ icon, error, className, ...props }, ref) => (
    <div className="w-full">
      <div className="relative">
        {icon && (
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
            {icon}
          </span>
        )}
        <input
          ref={ref}
          className={clsx(
            'w-full rounded-lg border bg-bg py-2 text-sm text-text outline-none transition-colors',
            'placeholder:text-text-muted',
            icon ? 'pl-10 pr-3' : 'px-3',
            error
              ? 'border-error focus:border-error'
              : 'border-border focus:border-accent',
            className,
          )}
          {...props}
        />
      </div>
      {error && <p className="mt-1 text-xs text-error">{error}</p>}
    </div>
  ),
);

Input.displayName = 'Input';
