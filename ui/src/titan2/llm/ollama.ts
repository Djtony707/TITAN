/**
 * Titan 3.0 Ollama Client
 * Real streaming to local/cloud Ollama. No mocks.
 */

import type { AgentMessage } from '../types';

const OLLAMA_BASE = '/ollama';
const DEFAULT_MODEL = 'kimi-k2.6:cloud';

export interface OllamaStreamChunk {
  model: string;
  created_at: string;
  message?: {
    role: string;
    content: string;
    thinking?: string;
  };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

export interface StreamCallbacks {
  onToken: (text: string) => void;
  onThinking?: (text: string) => void;
  onDone?: (stats: { totalDuration: number; promptTokens: number; evalTokens: number }) => void;
  onError?: (err: Error) => void;
}

function buildOllamaMessages(history: AgentMessage[], systemPrompt: string): Array<{ role: string; content: string }> {
  const msgs: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    msgs.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of history) {
    if (msg.role === 'framework') {
      msgs.push({ role: 'user', content: msg.content });
    } else {
      msgs.push({ role: msg.role, content: msg.content });
    }
  }
  return msgs;
}

export async function streamChat(
  history: AgentMessage[],
  systemPrompt: string,
  callbacks: StreamCallbacks,
  options?: { model?: string; signal?: AbortSignal }
): Promise<void> {
  const model = options?.model || DEFAULT_MODEL;
  const messages = buildOllamaMessages(history, systemPrompt);

  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  if (!res.body) {
    throw new Error('No response body from Ollama');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let contentBuffer = '';
  let thinkingBuffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk: OllamaStreamChunk = JSON.parse(line);

          if (chunk.message?.thinking) {
            thinkingBuffer += chunk.message.thinking;
            callbacks.onThinking?.(chunk.message.thinking);
          }

          if (chunk.message?.content) {
            contentBuffer += chunk.message.content;
            callbacks.onToken(chunk.message.content);
          }

          if (chunk.done) {
            callbacks.onDone?.({
              totalDuration: chunk.total_duration || 0,
              promptTokens: chunk.prompt_eval_count || 0,
              evalTokens: chunk.eval_count || 0,
            });
            return;
          }
        } catch {
          // Skip malformed NDJSON lines
        }
      }
    }
    // Flush any remaining multi-byte characters in the decoder
    buffer += decoder.decode();
    if (buffer.trim()) {
      try {
        const chunk: OllamaStreamChunk = JSON.parse(buffer.trim());
        if (chunk.message?.content) callbacks.onToken(chunk.message.content);
        if (chunk.message?.thinking) callbacks.onThinking?.(chunk.message.thinking);
        if (chunk.done) {
          callbacks.onDone?.({
            totalDuration: chunk.total_duration || 0,
            promptTokens: chunk.prompt_eval_count || 0,
            evalTokens: chunk.eval_count || 0,
          });
          return;
        }
      } catch { /* final buffer not valid JSON */ }
    }
    // Stream ended naturally without a done flag — still signal completion
    callbacks.onDone?.({ totalDuration: 0, promptTokens: 0, evalTokens: 0 });
  } finally {
    reader.releaseLock();
  }
}

export async function generateOnce(
  prompt: string,
  options?: { model?: string; system?: string }
): Promise<string> {
  const model = options?.model || DEFAULT_MODEL;

  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      system: options?.system || '',
      stream: false,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Ollama error ${res.status}: ${text}`);
  }

  const data = await res.json();
  return data.response || '';
}

export async function listModels(): Promise<Array<{ name: string; size: number; parameter_size?: string }>> {
  const res = await fetch(`${OLLAMA_BASE}/api/tags`);
  if (!res.ok) throw new Error('Failed to list models');
  const data = await res.json();
  return (data.models || []).map((m: any) => ({
    name: m.name,
    size: m.size,
    parameter_size: m.details?.parameter_size,
  }));
}
