/* ═══════════════════════════════════════════════════════════════════
   TITAN Query Keys — Centralized cache key management
   Pattern ported from Space Agent (Paperclip)
   ═══════════════════════════════════════════════════════════════════ */

export const queryKeys = {
  health: ['health'] as const,
  config: ['config'] as const,
  agents: {
    list: () => ['agents', 'list'] as const,
    detail: (id: string) => ['agents', 'detail', id] as const,
    runs: (id?: string) => ['agents', 'runs', id ?? 'all'] as const,
  },
  sessions: {
    list: () => ['sessions', 'list'] as const,
    messages: (id: string) => ['sessions', 'messages', id] as const,
  },
  skills: {
    list: () => ['skills', 'list'] as const,
  },
  tools: {
    list: () => ['tools', 'list'] as const,
  },
  files: {
    roots: () => ['files', 'roots'] as const,
    list: (path: string, root: string) => ['files', 'list', root, path] as const,
  },
  traces: {
    list: () => ['traces', 'list'] as const,
  },
  dashboard: ['dashboard'] as const,
};
