import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { Widget, ChatMessage } from './types';
import { compileWidgetCode, executeWidgetCode } from './widgetCompiler';
import { trackEvent } from '@/api/telemetry';

interface TitanRuntime {
  widgets: {
    create: (def: Omit<Widget, 'id' | 'createdAt'>) => Promise<string>;
    createSystem: (title: string, component: React.FC<any>, w?: number, h?: number) => string;
    update: (id: string, def: Partial<Widget>) => void;
    remove: (id: string) => void;
    list: () => Widget[];
    get: (id: string) => Widget | undefined;
  };
  state: Map<string, any>;
  setState: (key: string, value: any) => void;
  getState: (key: string) => any;
  emit: (event: string, data: any) => void;
  on: (event: string, handler: (data: any) => void) => () => void;
  llm: {
    complete: (prompt: string) => Promise<string>;
  };
}

interface CanvasState {
  widgets: Widget[];
  messages: ChatMessage[];
  isLoading: boolean;
  runtime: TitanRuntime;
}

const CanvasContext = createContext<CanvasState | null>(null);

export function useCanvas() {
  const ctx = useContext(CanvasContext);
  if (!ctx) throw new Error('useCanvas must be used within CanvasProvider');
  return ctx;
}

export function CanvasProvider({ children }: { children: React.ReactNode }) {
  const [widgets, setWidgets] = useState<Widget[]>(() => {
    try {
      const saved = localStorage.getItem('titan-canvas-widgets');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const stateRef = useRef<Map<string, any>>(new Map());
  const listenersRef = useRef<Map<string, Set<(data: any) => void>>>(new Map());

  useEffect(() => {
    localStorage.setItem('titan-canvas-widgets', JSON.stringify(widgets));
  }, [widgets]);

  const runtime: TitanRuntime = {
    widgets: {
      createSystem: useCallback((title: string, component: React.FC<any>, w = 4, h = 4) => {
        const id = `panel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const widget: Widget = {
          id,
          title,
          code: '// system widget',
          component,
          x: 0,
          y: 0,
          w,
          h,
          createdAt: Date.now(),
        };
        setWidgets(prev => [...prev, widget]);
        trackEvent('canvas_system_panel_created', { title });
        return id;
      }, []),

      create: useCallback(async (def) => {
        const id = `panel_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        let component: React.FC<any> | undefined;
        let error: string | undefined;

        try {
          const compiled = await compileWidgetCode(def.code);
          component = executeWidgetCode(compiled, { React });
        } catch (err: any) {
          error = err.message;
        }

        const widget: Widget = {
          id,
          title: def.title,
          code: def.code,
          compiledCode: undefined,
          component,
          error,
          x: def.x ?? 0,
          y: def.y ?? 0,
          w: def.w ?? 4,
          h: def.h ?? 4,
          createdAt: Date.now(),
        };

        setWidgets(prev => [...prev, widget]);
        trackEvent('canvas_panel_created', { title: def.title, hasError: !!error });
        return id;
      }, []),

      update: useCallback((id, def) => {
        setWidgets(prev => prev.map(w => w.id === id ? { ...w, ...def } : w));
        trackEvent('canvas_panel_updated', { panelId: id });
      }, []),

      remove: useCallback((id) => {
        setWidgets(prev => prev.filter(w => w.id !== id));
        trackEvent('canvas_panel_removed', { panelId: id });
      }, []),

      list: useCallback(() => widgets, [widgets]),

      get: useCallback((id) => widgets.find(w => w.id === id), [widgets]),
    },

    state: stateRef.current,

    setState: useCallback((key, value) => {
      stateRef.current.set(key, value);
    }, []),

    getState: useCallback((key) => {
      return stateRef.current.get(key);
    }, []),

    emit: useCallback((event, data) => {
      const listeners = listenersRef.current.get(event);
      if (listeners) {
        listeners.forEach(handler => {
          try { handler(data); } catch (e) { console.error('Event handler error:', e); }
        });
      }
    }, []),

    on: useCallback((event, handler) => {
      if (!listenersRef.current.has(event)) {
        listenersRef.current.set(event, new Set());
      }
      listenersRef.current.get(event)!.add(handler);
      return () => {
        listenersRef.current.get(event)?.delete(handler);
      };
    }, []),

    llm: {
      complete: async (prompt: string) => {
        return `[LLM response for: ${prompt.slice(0, 50)}...]`;
      },
    },
  };

  return (
    <CanvasContext.Provider value={{ widgets, messages, isLoading, runtime }}>
      {children}
    </CanvasContext.Provider>
  );
}
