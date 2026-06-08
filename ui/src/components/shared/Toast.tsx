import { createContext, useContext, useCallback, useState, type ReactNode } from 'react';
import { CheckCircle2, XCircle, AlertCircle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const accentByType: Record<ToastType, string> = {
  success: 'var(--theme-leather-stitch)',
  error: 'var(--theme-accent)',
  warning: 'var(--theme-metal-bright)',
  info: 'var(--theme-metal)',
};

function ToastIcon({ type }: { type: ToastType }) {
  const color = accentByType[type];
  const props = { size: 16, style: { color } };
  switch (type) {
    case 'success':
      return <CheckCircle2 {...props} />;
    case 'error':
      return <XCircle {...props} />;
    case 'warning':
      return <AlertCircle {...props} />;
    case 'info':
      return <Info {...props} />;
  }
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}

      {/* Toast container */}
      <div
        className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
        style={{ fontFamily: 'var(--theme-font-display)' }}
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            // v7.0 a11y — errors/warnings announce assertively (interrupt), while
            // success/info announce politely. aria-atomic so the whole message is read.
            role={t.type === 'error' || t.type === 'warning' ? 'alert' : 'status'}
            aria-atomic="true"
            className="titan-toast-surface pointer-events-auto flex items-center gap-2.5 px-4 py-3"
            style={{ borderLeft: `3px solid ${accentByType[t.type]}` }}
          >
            <ToastIcon type={t.type} />
            <span className="text-sm" style={{ color: 'var(--theme-ink)' }}>
              {t.message}
            </span>
            <button
              onClick={() => dismiss(t.id)}
              className="titan-close-btn ml-2"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
