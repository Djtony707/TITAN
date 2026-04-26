/**
 * Hybrid Canvas client for TITAN.
 *
 * Primary: TITAN's /api/message SSE pipeline (auth, sessions, tools, agents, telemetry)
 * Fallback: Direct Ollama /api/generate (for local prototyping when TITAN gateway is down)
 */

import { streamMessage } from '@/api/client';
import type { StreamEvent, ChatMessage } from '@/api/types';

const MODEL = 'kimi-k2.6:cloud';
let titanHealthy: boolean | null = null;
let healthCheckPromise: Promise<boolean> | null = null;

export interface CanvasStreamEvent {
  type: 'token' | 'tool_start' | 'tool_end' | 'thinking' | 'round' | 'done' | 'error';
  data: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolSuccess?: boolean;
  toolDurationMs?: number;
  round?: number;
  maxRounds?: number;
  sessionId?: string;
  model?: string;
  durationMs?: number;
  toolsUsed?: string[];
  errorCode?: string;
  errorMessage?: string;
  errorAction?: { type: string; target: string; label: string };
  pendingApproval?: boolean;
}

/**
 * Check if TITAN backend is reachable.
 */
export async function checkTitanHealth(): Promise<boolean> {
  if (titanHealthy !== null) return titanHealthy;
  if (healthCheckPromise) return healthCheckPromise;

  healthCheckPromise = new Promise(async (resolve) => {
    try {
      const res = await fetch('/api/health', { method: 'GET', signal: AbortSignal.timeout(5000) });
      titanHealthy = res.ok;
      resolve(titanHealthy);
    } catch {
      titanHealthy = false;
      resolve(false);
    }
  });

  return healthCheckPromise;
}

/**
 * Send a message through TITAN's pipeline (or Ollama fallback).
 */
export async function sendCanvasMessage(
  content: string,
  sessionId: string | undefined,
  onEvent: (event: CanvasStreamEvent) => void,
  signal: AbortSignal,
  options?: { agentId?: string },
): Promise<{ content: string; sessionId?: string; model?: string; durationMs?: number; toolsUsed?: string[] }> {
  const isTitan = await checkTitanHealth();

  if (isTitan) {
    return sendViaTitan(content, sessionId, onEvent, signal, options);
  }

  return sendViaOllama(content, onEvent, signal);
}

/* ─── TITAN Pipeline ─── */

async function sendViaTitan(
  content: string,
  sessionId: string | undefined,
  onEvent: (event: CanvasStreamEvent) => void,
  signal: AbortSignal,
  options?: { agentId?: string },
): Promise<{ content: string; sessionId?: string; model?: string; durationMs?: number; toolsUsed?: string[] }> {
  let fullContent = '';
  let resultSessionId = sessionId;
  let toolsUsed: string[] = [];
  let model = '';
  let durationMs = 0;

  await streamMessage(
    content,
    sessionId,
    (event: StreamEvent) => {
      if (event.type === 'token') {
        fullContent += event.data;
      }
      onEvent(event as CanvasStreamEvent);
    },
    signal,
    options,
  );

  return { content: fullContent, sessionId: resultSessionId, model, durationMs, toolsUsed };
}

/* ─── Ollama Fallback ─── */

async function sendViaOllama(
  content: string,
  onEvent: (event: CanvasStreamEvent) => void,
  signal: AbortSignal,
): Promise<{ content: string; model?: string }> {
  const res = await fetch('/ollama/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt: content,
      stream: true,
      options: { temperature: 0.7, num_predict: 4096 },
    }),
    signal,
  });

  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${res.statusText}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let fullResponse = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n').filter(Boolean);

    for (const line of lines) {
      try {
        const data = JSON.parse(line);
        if (data.response) {
          fullResponse += data.response;
          onEvent({ type: 'token', data: data.response });
        }
        if (data.done) {
          onEvent({ type: 'done', data: fullResponse });
        }
      } catch {
        // Ignore malformed JSON lines
      }
    }
  }

  return { content: fullResponse, model: MODEL };
}
