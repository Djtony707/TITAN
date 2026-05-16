import { useEffect, useCallback, type ReactNode } from 'react';
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
}

const sizeStyles = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
};

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  hideCloseButton = false,
}: ModalProps) {
  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, handleEscape]);

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
            className={clsx('relative w-full mx-4 titan-modal-surface', sizeStyles[size])}
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
