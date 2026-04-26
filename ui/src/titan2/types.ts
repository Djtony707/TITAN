import type React from 'react';

// ── Widget Types ──────────────────────────────────────────────

// 'html' matches what SandboxRuntime.render already accepts — the type
// was out of sync with the runtime, which broke the WidgetEditor's
// format dropdown on typecheck.
export type WidgetFormat = 'react' | 'vanilla' | 'html' | 'iframe' | 'system';

export interface WidgetVersion {
  source: string;
  format: WidgetFormat;
  savedAt: number;
  note?: string;
}

export interface WidgetDef {
  id: string;
  name: string;
  title?: string;
  format: WidgetFormat;
  source: string;
  x: number;
  y: number;
  w: number;
  h: number;
  metadata?: Record<string, unknown>;
  /**
   * Prior (source, format) pairs, oldest → newest. Pushed to whenever the
   * WidgetEditor saves a change so the user can revert. Cap enforced in
   * the editor (WIDGET_HISTORY_MAX) to stop the blob from growing forever.
   */
  versions?: WidgetVersion[];
  createdAt: number;
  updatedAt: number;
}

export interface SystemWidgetDef extends WidgetDef {
  format: 'system';
  component: React.FC<any>;
}

// ── Space Types ───────────────────────────────────────────────

export interface Space {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  widgets: WidgetDef[];
  agentInstructions?: string;
  scripts?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

// ── Sandbox Types ─────────────────────────────────────────────

export interface SandboxMessage {
  type: 'init' | 'render' | 'execute' | 'api' | 'state' | 'log' | 'error' | 'result';
  id: string;
  payload?: any;
}

export interface SandboxAPI {
  fetch: (url: string, options?: RequestInit) => Promise<any>;
  call: (endpoint: string, body?: any) => Promise<any>;
  setState: (key: string, value: any) => void;
  getState: (key: string) => any;
  log: (...args: any[]) => void;
}

// ── Agent Protocol Types ──────────────────────────────────────

export type AgentGate = '_____javascript' | '_____react' | '_____tool' | '_____widget' | '_____framework' | '_____transient';

export interface ExecutionBlock {
  gate: AgentGate;
  code: string;
  leadingText: string;
}

export interface ExecutionResult {
  status: 'success' | 'error';
  logs: Array<{ level: string; text: string }>;
  result?: any;
  resultText: string;
  error?: { message: string; name: string; stack: string; text: string };
  runId: number;
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'framework' | 'system';
  content: string;
  timestamp: number;
  executions?: ExecutionResult[];
  attachments?: Attachment[];
}

export interface Attachment {
  id: string;
  type: 'image' | 'file' | 'text';
  name: string;
  url?: string;
  content?: string;
}

// ── Chat Types ────────────────────────────────────────────────

export interface ChatThread {
  id: string;
  messages: AgentMessage[];
  isStreaming: boolean;
  displayMode: 'compact' | 'full';
}

// ── Runtime Types ─────────────────────────────────────────────

export interface TitanRuntime {
  spaces: {
    list: () => Space[];
    get: (id: string) => Space | undefined;
    create: (name: string) => Space;
    open: (id: string) => void;
    save: (space: Space) => void;
    remove: (id: string) => void;
  };
  widgets: {
    create: (def: Omit<WidgetDef, 'id' | 'createdAt' | 'updatedAt'>) => string;
    update: (id: string, patch: Partial<WidgetDef>) => void;
    remove: (id: string) => void;
    render: (widget: WidgetDef) => void;
  };
  chat: {
    send: (text: string) => Promise<void>;
    getThread: () => ChatThread;
  };
  api: {
    fetch: typeof fetch;
    call: (endpoint: string, body?: any) => Promise<any>;
  };
  state: {
    get: (key: string) => any;
    set: (key: string, value: any) => void;
    subscribe: (key: string, handler: (value: any) => void) => () => void;
  };
  llm: {
    complete: (messages: AgentMessage[]) => AsyncIterable<string>;
  };
}
