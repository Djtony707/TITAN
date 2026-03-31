import { useState, useCallback, useRef } from 'react';
import { streamMessage } from '@/api/client';
import type { StreamEvent, ChatMessage, AgentEvent } from '@/api/types';

interface UseSSEReturn {
  isStreaming: boolean;
  streamingContent: string;
  activeTools: string[];
  agentEvents: AgentEvent[];
  send: (message: string, sessionId?: string, options?: { agentId?: string }) => Promise<ChatMessage | null>;
  cancel: () => void;
}

let eventIdCounter = 0;

export function useSSE(): UseSSEReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const eventBufferRef = useRef<AgentEvent[]>([]);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
  }, []);

  const send = useCallback(
    async (message: string, sessionId?: string, options?: { agentId?: string }): Promise<ChatMessage | null> => {
      setIsStreaming(true);
      setStreamingContent('');
      setActiveTools([]);
      setAgentEvents([]);
      eventBufferRef.current = [];

      // RAF-based event flushing to prevent render thrashing
      const flushEvents = () => {
        if (eventBufferRef.current.length > 0) {
          const batch = [...eventBufferRef.current];
          eventBufferRef.current = [];
          setAgentEvents((prev) => [...prev, ...batch]);
        }
        rafRef.current = requestAnimationFrame(flushEvents);
      };
      rafRef.current = requestAnimationFrame(flushEvents);

      const pushEvent = (evt: Omit<AgentEvent, 'id' | 'timestamp'>) => {
        eventBufferRef.current.push({ ...evt, id: `evt-${++eventIdCounter}`, timestamp: Date.now() } as AgentEvent);
      };

      const controller = new AbortController();
      abortRef.current = controller;

      let fullContent = '';
      let resultSessionId = sessionId;
      let toolsUsed: string[] = [];
      let model = '';
      let durationMs = 0;

      try {
        await streamMessage(
          message,
          sessionId,
          (event: StreamEvent) => {
            switch (event.type) {
              case 'token':
                fullContent += event.data;
                setStreamingContent(fullContent);
                pushEvent({ type: 'token', status: 'success' });
                break;
              case 'tool_start':
                if (event.toolName) {
                  setActiveTools((prev) => [...prev, event.toolName!]);
                  pushEvent({ type: 'tool_start', toolName: event.toolName, args: event.toolArgs, status: 'running' });
                }
                break;
              case 'tool_end':
                if (event.toolName) {
                  setActiveTools((prev) => prev.filter((t) => t !== event.toolName));
                  pushEvent({ type: 'tool_end', toolName: event.toolName, result: event.toolResult, durationMs: event.toolDurationMs, status: event.toolSuccess ? 'success' : 'error' });
                }
                break;
              case 'thinking':
                pushEvent({ type: 'thinking', status: 'running' });
                break;
              case 'round':
                pushEvent({ type: 'round', round: event.round, maxRounds: event.maxRounds, status: 'running' });
                break;
              case 'done':
                if (event.sessionId) resultSessionId = event.sessionId;
                if (event.toolsUsed) toolsUsed = event.toolsUsed;
                if (event.model) model = event.model;
                if (event.durationMs) durationMs = event.durationMs;
                pushEvent({ type: 'done', status: 'success' });
                break;
              case 'error':
                console.error('Stream error:', event.data);
                pushEvent({ type: 'done', status: 'error', result: event.data });
                break;
            }
          },
          controller.signal,
          options,
        );
      } catch (e) {
        if ((e as Error).name === 'AbortError') return null;
        throw e;
      } finally {
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        // Final flush
        if (eventBufferRef.current.length > 0) {
          const batch = [...eventBufferRef.current];
          eventBufferRef.current = [];
          setAgentEvents((prev) => [...prev, ...batch]);
        }
        setIsStreaming(false);
        setStreamingContent('');
        setActiveTools([]);
        abortRef.current = null;
      }

      return {
        role: 'assistant',
        content: fullContent,
        toolsUsed,
        model,
        durationMs,
        timestamp: new Date().toISOString(),
      };
    },
    [],
  );

  return { isStreaming, streamingContent, activeTools, agentEvents, send, cancel };
}
