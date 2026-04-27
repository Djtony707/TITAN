import { useState, useCallback, useRef } from 'react';
import { streamMessage } from '@/api/client';
import type { StreamEvent, ChatMessage, AgentEvent, ToolInvocation } from '@/api/types';

interface UseSSEReturn {
  isStreaming: boolean;
  streamingContent: string;
  activeTools: string[];
  agentEvents: AgentEvent[];
  toolInvocations: ToolInvocation[];
  /** True when the last response was a plan waiting for approval */
  pendingApproval: boolean;
  /** Last structured error from the gateway, if any */
  lastError: { code?: string; message?: string; action?: { type: string; target: string; label: string } } | null;
  send: (message: string, sessionId?: string, options?: { agentId?: string }) => Promise<ChatMessage | null>;
  cancel: () => void;
  clearError: () => void;
}

let eventIdCounter = 0;

export function useSSE(): UseSSEReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const [toolInvocations, setToolInvocations] = useState<ToolInvocation[]>([]);
  const [lastError, setLastError] = useState<UseSSEReturn['lastError']>(null);
  // Tracks whether the most-recent response is a plan waiting for user
  // approval. Promoted from a local closure variable so the returned
  // `pendingApproval` actually reflects state across renders — pre-fix
  // the hook always returned `false` regardless of SSE content.
  const [isPendingApproval, setIsPendingApproval] = useState(false);
  const eventBufferRef = useRef<AgentEvent[]>([]);
  const toolMapRef = useRef<Map<string, ToolInvocation>>(new Map());
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    // Final flush of buffered events
    if (eventBufferRef.current.length > 0) {
      const batch = [...eventBufferRef.current];
      eventBufferRef.current = [];
      setAgentEvents((prev) => [...prev, ...batch]);
    }
    setIsStreaming(false);
  }, []);

  const send = useCallback(
    async (message: string, sessionId?: string, options?: { agentId?: string }): Promise<ChatMessage | null> => {
      setIsStreaming(true);
      setStreamingContent('');
      setActiveTools([]);
      setAgentEvents([]);
      setToolInvocations([]);
      toolMapRef.current = new Map();
      setLastError(null);
      setIsPendingApproval(false);
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
      let pendingApprovalLocal = false;

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
                  const key = `${event.toolName}-${Date.now()}`;
                  toolMapRef.current.set(key, {
                    toolName: event.toolName,
                    status: 'running',
                    args: event.toolArgs,
                    startedAt: Date.now(),
                  });
                  setToolInvocations(Array.from(toolMapRef.current.values()));
                }
                break;
              case 'tool_end':
                if (event.toolName) {
                  setActiveTools((prev) => prev.filter((t) => t !== event.toolName));
                  pushEvent({ type: 'tool_end', toolName: event.toolName, result: event.toolResult, durationMs: event.toolDurationMs, status: event.toolSuccess ? 'success' : 'error' });
                  // Update the most recent running invocation for this tool
                  const entries = Array.from(toolMapRef.current.entries());
                  const match = entries.reverse().find(([, inv]) => inv.toolName === event.toolName && inv.status === 'running');
                  if (match) {
                    toolMapRef.current.set(match[0], {
                      ...match[1],
                      status: event.toolSuccess ? 'success' : 'error',
                      result: event.toolResult,
                      diff: event.toolDiff,
                      durationMs: event.toolDurationMs,
                      endedAt: Date.now(),
                    });
                    setToolInvocations(Array.from(toolMapRef.current.values()));
                  }
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
                if (event.pendingApproval) {
                  pendingApprovalLocal = true;
                  setIsPendingApproval(true);
                }
                // If the done event carries content and we didn't stream any tokens
                // (e.g. plan responses arrive as a single done event, not token-by-token),
                // use the done event's content as the full message.
                if (event.data && !fullContent) {
                  fullContent = event.data;
                }
                pushEvent({ type: 'done', status: 'success' });
                break;
              case 'error':
                // Surface structured errors from classifyChatError
                setLastError({
                  code: event.errorCode,
                  message: event.errorMessage || event.data,
                  action: event.errorAction,
                });
                pushEvent({ type: 'done', status: 'error', result: event.data });
                break;
            }
          },
          controller.signal,
          options,
        );
      } catch (e) {
        if ((e as Error).name === 'AbortError') return null;
        // Surface fetch / network errors
        setLastError({
          code: 'network_error',
          message: (e as Error).message || 'Could not reach TITAN. Check your connection.',
        });
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
        toolInvocations: Array.from(toolMapRef.current.values()),
        model,
        durationMs,
        timestamp: new Date().toISOString(),
        pendingApproval: pendingApprovalLocal,
      };
    },
    [],
  );

  return { isStreaming, streamingContent, activeTools, agentEvents, toolInvocations, pendingApproval: isPendingApproval, lastError, send, cancel, clearError };
}
