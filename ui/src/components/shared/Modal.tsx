import { useEffect, useCallback, useRef, useId, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import clsx from 'clsx';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Hide the built-in close (×) button (e.g. for blocking confirmations). */
  hideCloseButton?: boolean;
  /**
   * Accessible name when no visible `title` is rendered. Required for a11y in
   * that case so the dialog is never announced as just "dialog".
   */
  ariaLabel?: string;
}

const sizeStyles = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  hideCloseButton = false,
  ariaLabel,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // v7.0 a11y — Escape to close + a focus trap so keyboard/screen-reader users
  // can't Tab out of the dialog into the background (WCAG 2.4.3 / 2.1.2).
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        e.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    // Remember what had focus so we can restore it when the dialog closes.
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    document.addEventListener('keydown', handleKeyDown);
    // Move focus into the dialog (first focusable, else the panel itself).
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const target =
        panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
      target.focus();
    });
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      cancelAnimationFrame(raf);
      // Restore focus to the trigger so keyboard users aren't dropped at the top.
      restoreFocusRef.current?.focus?.();
    };
  }, [open, handleKeyDown]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]">
          {/* Backdrop — themed overlay */}
          <motion.div
            className="absolute inset-0 titan-menu-overlay"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          />

          {/* Panel */}
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-label={!title ? ariaLabel : undefined}
            tabIndex={-1}
            className={clsx(
              'relative w-full mx-4 titan-modal-surface outline-none',
              sizeStyles[size],
            )}
            initial={{ opacity: 0, y: -16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.97 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            {title && (
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{ borderBottom: '1px solid var(--theme-menu-border)' }}
              >
                <h2
                  id={titleId}
                  className="text-base font-semibold"
                  style={{ color: 'var(--theme-ink)', fontFamily: 'var(--theme-font-display)' }}
                >
                  {title}
                </h2>
                {!hideCloseButton && (
                  <button
                    type="button"
                    onClick={onClose}
                    className="titan-close-btn"
                    aria-label="Close"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            )}
            <div
              className="px-4 py-4"
              style={{
                color: 'var(--theme-ink)',
                fontFamily: 'var(--theme-font-display)',
              }}
            >
              {children}
            </div>
            {footer && (
              <div
                className="flex items-center justify-end gap-2 px-4 py-3"
                style={{ borderTop: '1px solid var(--theme-menu-border)' }}
              >
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
