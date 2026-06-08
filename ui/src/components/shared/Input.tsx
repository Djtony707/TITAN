import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  icon?: ReactNode;
  error?: string;
  /**
   * Visible, programmatically-associated label (v7.0 a11y). Strongly preferred —
   * it auto-wires `htmlFor`/`id` so screen readers announce the field. If you
   * intentionally omit a visible label, pass an `aria-label` instead so the
   * input is never nameless. A placeholder alone is NOT an accessible name.
   */
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ icon, error, label, className, id, ...props }, ref) => {
    // Stable, unique id so the <label>, the input, and the error message are
    // all programmatically linked even when the caller doesn't supply an id.
    const reactId = useId();
    const inputId = id ?? reactId;
    const errorId = `${inputId}-error`;

    return (
      <div className="w-full">
        {label && (
          <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-text">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none">
              {icon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={clsx(
              'w-full rounded-lg border bg-bg py-2 text-sm text-text outline-none transition-colors',
              'placeholder:text-text-muted',
              // v7.0 — a consistent, visible keyboard focus ring (focus-visible
              // only shows it for keyboard users, not mouse clicks).
              'focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-bg',
              icon ? 'pl-10 pr-3' : 'px-3',
              error
                ? 'border-error focus:border-error'
                : 'border-border focus:border-accent',
              className,
            )}
            {...props}
          />
        </div>
        {error && (
          <p id={errorId} role="alert" className="mt-1 text-xs text-error">
            {error}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = 'Input';
