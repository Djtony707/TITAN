import { useState, useCallback, useRef } from 'react';
import { sendCanvasMessage, checkTitanHealth, type CanvasStreamEvent } from './canvasClient';
import type { ChatMessage as ApiChatMessage } from '@/api/types';

interface UseCanvasSSEReturn {
  isStreaming: boolean;
  streamingContent: string;
  activeTools: string[];
  titanHealthy: boolean | null;
  lastError: { code?: string; message?: string; action?: { type: string; target: string; label: string } } | null;
  send: (message: string, sessionId?: string, options?: { agentId?: string }) => Promise<ApiChatMessage | null>;
  cancel: () => void;
  clearError: () => void;
  checkHealth: () => Promise<boolean>;
}

export function useCanvasSSE(): UseCanvasSSEReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [titanHealthy, setTitanHealthy] = useState<boolean | null>(null);
  const [lastError, setLastError] = useState<UseCanvasSSEReturn['lastError']>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clearError = useCallback(() => {
    setLastError(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setIsStreaming(false);
    setActiveTools([]);
  }, []);

  const checkHealth = useCallback(async () => {
    const healthy = await checkTitanHealth();
    setTitanHealthy(healthy);
    return healthy;
  }, []);

  const send = useCallback(
    async (message: string, sessionId?: string, options?: { agentId?: string }): Promise<ApiChatMessage | null> => {
      setIsStreaming(true);
      setStreamingContent('');
      setActiveTools([]);
      setLastError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      let fullContent = '';
      let resultModel = '';
      let resultDurationMs = 0;
      let resultToolsUsed: string[] = [];

      try {
        const result = await sendCanvasMessage(
          message,
          sessionId,
          (event: CanvasStreamEvent) => {
            switch (event.type) {
              case 'token':
                fullContent += event.data;
                setStreamingContent(fullContent);
                break;
              case 'tool_start':
                if (event.toolName) {
                  setActiveTools((prev) => [...prev, event.toolName!]);
                }
                break;
              case 'tool_end':
                if (event.toolName) {
                  setActiveTools((prev) => prev.filter((t) => t !== event.toolName));
                }
                break;
              case 'done':
                if (event.model) resultModel = event.model;
                if (event.durationMs) resultDurationMs = event.durationMs;
                if (event.toolsUsed) resultToolsUsed = event.toolsUsed;
                break;
              case 'error':
                setLastError({
                  code: event.errorCode,
                  message: event.errorMessage || event.data,
                  action: event.errorAction,
                });
                break;
            }
          },
          controller.signal,
          options,
        );

        fullContent = result.content;
        if (result.model) resultModel = result.model;
        if (result.durationMs) resultDurationMs = result.durationMs;
        if (result.toolsUsed) resultToolsUsed = result.toolsUsed;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return null;
        setLastError({
          code: 'network_error',
          message: (e as Error).message || 'Could not reach TITAN or Ollama. Check your connection.',
        });
        throw e;
      } finally {
        setIsStreaming(false);
        setStreamingContent('');
        setActiveTools([]);
        abortRef.current = null;
      }

      return {
        role: 'assistant',
        content: fullContent,
        toolsUsed: resultToolsUsed,
        toolInvocations: [],
        model: resultModel,
        durationMs: resultDurationMs,
        timestamp: new Date().toISOString(),
        pendingApproval: false,
      };
    },
    [],
  );

  return { isStreaming, streamingContent, activeTools, titanHealthy, lastError, send, cancel, clearError, checkHealth };
}
