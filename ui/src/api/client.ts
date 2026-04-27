import type {
  SendMessageResponse,
  Session,
  TitanConfig,
  HealthStatus,
  VoiceHealth,
  SystemStats,
  AgentInfo,
  SkillInfo,
  ToolInfo,
  ChannelInfo,
  ChannelConfig,
  MeshPeer,
  LiveKitTokenResponse,
  LogEntry,
  ModelInfo,
  PersonaMeta,
  ChatMessage,
  StreamEvent,
  ActivityEvent,
  ActivitySummary,
  CommandPostDashboard,
  RegisteredAgent,
  TaskCheckout,
  BudgetPolicy,
  BudgetReservation,
  CPActivityEntry,
  GoalTreeNode,
  CPIssue,
  CPComment,
  CPApproval,
  CPRun,
  OrgNode,
} from './types';

import { trackEvent } from './telemetry';

const BASE = '';

export function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('titan-token');
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

/** Authenticated fetch — wraps native fetch with auth token injection */
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = { ...authHeaders(), ...init?.headers as Record<string, string> };
  return fetch(input, { ...init, headers });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

// ---- Chat ----

export async function sendMessage(
  content: string,
  sessionId?: string,
  options?: { model?: string; agentId?: string },
): Promise<SendMessageResponse> {
  trackEvent('chat_message_sent', { streaming: false, hasSession: !!sessionId });
  return request('/api/message', {
    method: 'POST',
    body: JSON.stringify({
      content,
      sessionId,
      ...(options?.model && { model: options.model }),
      ...(options?.agentId && { agentId: options.agentId }),
    }),
  });
}

export function streamMessage(
  content: string,
  sessionId?: string,
  onEvent?: (event: StreamEvent) => void,
  signal?: AbortSignal,
  options?: { agentId?: string; systemPromptAppendix?: string },
): Promise<void> {
  trackEvent('chat_message_sent', { streaming: true, hasSession: !!sessionId });
  return new Promise((resolve, reject) => {
    fetch(`${BASE}/api/message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...authHeaders(),
      },
      body: JSON.stringify({
        content,
        sessionId,
        ...(options?.agentId && { agentId: options.agentId }),
        ...(options?.systemPromptAppendix && { systemPromptAppendix: options.systemPromptAppendix }),
      }),
      signal,
    })
      .then((res) => {
        if (!res.ok) {
          reject(new Error(`${res.status}: ${res.statusText}`));
          return;
        }
        const reader = res.body?.getReader();
        if (!reader) {
          reject(new Error('No response body'));
          return;
        }
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEventType = '';

        function read(): void {
          reader!.read().then(({ done, value }) => {
            if (done) {
              resolve();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEventType = line.slice(7).trim();
              } else if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') {
                  resolve();
                  return;
                }
                try {
                  const parsed = JSON.parse(data);
                  // Map gateway SSE events to StreamEvent format
                  const eventType = currentEventType || parsed.type || 'token';
                  if (eventType === 'token') {
                    onEvent?.({ type: 'token', data: parsed.text ?? parsed.data ?? '' });
                  } else if (eventType === 'tool_call') {
                    onEvent?.({ type: 'tool_start', data: '', toolName: parsed.name, toolArgs: parsed.args });
                  } else if (eventType === 'tool_end') {
                    onEvent?.({ type: 'tool_end', data: '', toolName: parsed.name, toolResult: parsed.result, toolDurationMs: parsed.durationMs, toolSuccess: parsed.success, toolDiff: parsed.diff });
                  } else if (eventType === 'thinking') {
                    onEvent?.({ type: 'thinking', data: '' });
                  } else if (eventType === 'round') {
                    onEvent?.({ type: 'round', data: '', round: parsed.round, maxRounds: parsed.maxRounds });
                  } else if (eventType === 'done') {
                    // If the done event carries a structured error (classifyChatError),
                    // propagate as an 'error' event so the Chat UI renders a banner
                    if (parsed.error && !parsed.content) {
                      onEvent?.({
                        type: 'error',
                        data: parsed.message ?? parsed.error ?? 'Unknown error',
                        errorCode: parsed.error,
                        errorMessage: parsed.message,
                        errorAction: parsed.action,
                      });
                    } else {
                      onEvent?.({
                        type: 'done',
                        data: parsed.content ?? '',
                        sessionId: parsed.sessionId,
                        model: parsed.model,
                        durationMs: parsed.durationMs,
                        toolsUsed: parsed.toolsUsed,
                        pendingApproval: parsed.pendingApproval,
                      });
                    }
                  } else if (eventType === 'error') {
                    onEvent?.({ type: 'error', data: parsed.error ?? parsed.message ?? '' });
                  } else {
                    onEvent?.({ type: parsed.type ?? 'token', data: parsed.text ?? parsed.data ?? '', ...parsed });
                  }
                } catch {
                  // non-JSON SSE data, treat as token
                  onEvent?.({ type: 'token', data });
                }
                currentEventType = '';
              } else if (line === '') {
                // Empty line resets event type per SSE spec
                currentEventType = '';
              }
            }
            read();
          }).catch(reject);
        }
        read();
      })
      .catch(reject);
  });
}

// ---- Sessions ----

export async function getSessions(): Promise<Session[]> {
  return request('/api/sessions');
}

export async function getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  const raw = await request<Array<Record<string, unknown>>>(`/api/sessions/${sessionId}/messages`);
  return raw.map((m) => ({
    role: (m.role as ChatMessage['role']) ?? 'assistant',
    content: (m.content as string) ?? '',
    timestamp: (m.createdAt as string) ?? (m.timestamp as string) ?? undefined,
    model: (m.model as string) ?? undefined,
  }));
}

export async function deleteSession(sessionId: string): Promise<void> {
  await request(`/api/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function renameSession(sessionId: string, name: string): Promise<void> {
  await request(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function abortSession(sessionId: string): Promise<void> {
  await request(`/api/sessions/${sessionId}/abort`, { method: 'POST' });
}

// ---- Config ----

export async function getConfig(): Promise<TitanConfig> {
  return request('/api/config');
}

export async function updateConfig(config: Partial<TitanConfig>): Promise<TitanConfig> {
  return request('/api/config', {
    method: 'POST',
    body: JSON.stringify(config),
  });
}

// ---- Health ----

export async function getHealth(): Promise<HealthStatus> {
  return request('/api/health');
}

export async function getVoiceHealth(): Promise<VoiceHealth> {
  return request('/api/voice/health');
}

// ---- Stats ----

export async function getStats(): Promise<SystemStats> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/api/stats');
  // API returns flat shape — normalize to what UI expects
  return {
    uptime: raw.uptime ?? 0,
    totalRequests: raw.totalRequests ?? 0,
    activeAgents: raw.activeAgents ?? 0,
    activeSessions: raw.activeSessions ?? 0,
    memoryUsage: raw.memoryUsage ?? {
      heapUsed: (raw.memoryMB ?? 0) * 1024 * 1024,
      heapTotal: (raw.memoryMB ?? 0) * 1024 * 1024 * 1.5,
      rss: 0,
      external: 0,
      arrayBuffers: 0,
    },
    version: raw.version ?? '',
    model: raw.model ?? raw.activeModel ?? '',
    provider: raw.provider ?? '',
  };
}

// ---- Agents ----

export async function getAgents(): Promise<{ agents: AgentInfo[]; capacity: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/api/agents');
  const agents = Array.isArray(raw) ? raw : (raw.agents ?? []);
  const capacity = raw.capacity ?? agents.length;
  return { agents, capacity };
}

export async function spawnAgent(name: string, model?: string): Promise<AgentInfo> {
  return request('/api/agents/spawn', {
    method: 'POST',
    body: JSON.stringify({ name, model }),
  });
}

export async function stopAgent(id: string): Promise<void> {
  await request(`/api/agents/stop`, {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

// ---- Specialists (per-agent model config) ----

export interface SpecialistInfo {
  id: string;
  name: string;
  role: string;
  title: string;
  defaultModel: string;
  activeModel: string;
  overridden: boolean;
}

export async function getSpecialists(): Promise<{ specialists: SpecialistInfo[] }> {
  return request('/api/specialists');
}

export async function updateSpecialistModel(id: string, model: string | null): Promise<void> {
  await request(`/api/specialists/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ model: model ?? '' }),
  });
}

// ---- Skills ----

export async function getSkills(): Promise<SkillInfo[]> {
  return request('/api/skills');
}

// ---- Tools ----

export async function getTools(): Promise<ToolInfo[]> {
  return request('/api/tools');
}

// ---- Channels ----

export async function getChannels(): Promise<ChannelInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any[]>('/api/channels');
  return (Array.isArray(raw) ? raw : []).map((ch) => ({
    name: ch.name ?? 'Unknown',
    type: ch.type ?? ch.name?.toLowerCase() ?? 'unknown',
    enabled: ch.enabled ?? ch.connected ?? false,
    status: ch.connected ? 'connected' as const : 'disconnected' as const,
  }));
}

export async function getChannelConfigs(): Promise<Record<string, ChannelConfig>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = await getConfig() as any;
  return cfg.channels ?? {};
}

export async function updateChannelConfig(
  channelName: string,
  config: Partial<ChannelConfig>,
): Promise<TitanConfig> {
  return updateConfig({ channels: { [channelName]: config } } as Partial<TitanConfig>);
}

// ---- Mesh ----

export async function getMeshPeers(): Promise<MeshPeer[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/api/mesh/peers');
  return Array.isArray(raw) ? raw : (raw.peers ?? []);
}

export async function getPendingPeers(): Promise<MeshPeer[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/api/mesh/pending');
  return Array.isArray(raw) ? raw : (raw.pending ?? []);
}

export async function approvePeer(id: string): Promise<void> {
  await request(`/api/mesh/approve/${id}`, { method: 'POST' });
}

export async function rejectPeer(id: string): Promise<void> {
  await request(`/api/mesh/reject/${id}`, { method: 'POST' });
}

export async function revokePeer(id: string): Promise<void> {
  await request(`/api/mesh/revoke/${id}`, { method: 'POST' });
}

// ---- Voice ----

export async function getLiveKitToken(): Promise<LiveKitTokenResponse> {
  return request('/api/livekit/token', { method: 'POST' });
}

export async function getVoiceStatus(): Promise<{ status: string }> {
  return request('/api/voice/status');
}

// ---- Logs ----

export async function getLogs(level?: string, limit?: number): Promise<LogEntry[]> {
  const params = new URLSearchParams();
  if (level) params.set('level', level);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>(`/api/logs${qs ? `?${qs}` : ''}`);
  if (Array.isArray(raw)) return raw;
  const lines: string[] = raw.lines ?? [];
  return lines.map((line) => {
    // Expected gateway log format (one line per record, written by
    // src/utils/logger.ts):
    //
    //   YYYY-MM-DD HH:MM:SS  <LEVEL>  <COMPONENT>  <message ...>
    //
    // <LEVEL> is one of DEBUG | INFO | WARN | ERROR.
    // Anything that doesn't match is surfaced as a level=info raw line so
    // the dashboard never drops content (timestamps may be absent on
    // continuation lines from tracebacks, multi-line tool output, etc.).
    //
    // Pre-fix history note: this regex once contained a corrupted "DEn"
    // alternation that silently dropped DEBUG/INFO/WARN/ERROR matches —
    // the dashboard then tagged every line as level=info, hiding real
    // ERROR/WARN entries from filter dropdowns. Keep the alternation
    // explicit: DEBUG|INFO|WARN|ERROR.
    const match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/);
    if (match) return { timestamp: match[1], level: match[2].toLowerCase(), message: match[3] };
    return { timestamp: '', level: 'info', message: line };
  });
}

// ---- Models ----

export async function getModels(): Promise<ModelInfo[]> {
  const raw = await request<Record<string, string[]>>('/api/models');
  // API returns { provider: ["provider/model", ...] } — flatten to ModelInfo[]
  const models: ModelInfo[] = [];
  for (const [provider, ids] of Object.entries(raw)) {
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      const name = id.includes('/') ? id.split('/').slice(1).join('/') : id;
      models.push({ id, name, provider, available: true });
    }
  }
  return models;
}

export async function switchModel(modelId: string, provider?: string): Promise<void> {
  await request('/api/model/switch', {
    method: 'POST',
    body: JSON.stringify({ model: modelId, provider }),
  });
}

// ---- Personas ----

export async function getPersonas(): Promise<{ personas: PersonaMeta[]; active: string }> {
  return request('/api/personas');
}

export async function switchPersona(persona: string): Promise<{ ok: boolean; active: string }> {
  return request('/api/persona/switch', {
    method: 'POST',
    body: JSON.stringify({ persona }),
  });
}

// ---- Metrics ----

export async function getMetricsSummary(): Promise<Record<string, unknown>> {
  return request('/api/metrics/summary');
}

// ---- Activity ----

export async function getActivityRecent(filter?: string, limit?: number): Promise<ActivityEvent[]> {
  const params = new URLSearchParams();
  if (filter && filter !== 'all') params.set('filter', filter);
  if (limit) params.set('limit', String(limit));
  const qs = params.toString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>(`/api/activity/recent${qs ? `?${qs}` : ''}`);
  return raw.events ?? [];
}

export async function getActivitySummary(): Promise<ActivitySummary> {
  return request('/api/activity/summary');
}

// ---- MCP ----

export async function getMcpClients(): Promise<import('./types').McpServerInfo[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/api/mcp/clients');
  return raw.servers ?? [];
}

export async function addMcpClient(server: Record<string, unknown>): Promise<{ ok: boolean; server?: unknown; error?: string }> {
  return request('/api/mcp/clients', { method: 'POST', body: JSON.stringify(server) });
}

export async function removeMcpClient(id: string): Promise<void> {
  await request(`/api/mcp/clients/${id}`, { method: 'DELETE' });
}

export async function toggleMcpClient(id: string, enabled: boolean): Promise<void> {
  await request(`/api/mcp/clients/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) });
}

export async function testMcpClient(id: string): Promise<{ ok: boolean; tools: number; error?: string }> {
  return request(`/api/mcp/clients/${id}/test`, { method: 'POST' });
}

export async function getMcpPresets(): Promise<import('./types').McpPreset[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/api/mcp/presets');
  return raw.presets ?? [];
}

// ---- Daemon ----

export async function getDaemonStatus(): Promise<import('./types').DaemonStatus> {
  return request('/api/daemon/status');
}

export async function pauseDaemon(): Promise<void> {
  await request('/api/daemon/stop', { method: 'POST' });
}

export async function resumeDaemon(): Promise<void> {
  await request('/api/daemon/resume', { method: 'POST' });
}

// ---- Audit ----

export async function getAuditLog(params?: { since?: string; action?: string; source?: string; limit?: number }): Promise<import('./types').AuditEntry[]> {
  const qs = new URLSearchParams();
  if (params?.since) qs.set('since', params.since);
  if (params?.action) qs.set('action', params.action);
  if (params?.source) qs.set('source', params.source);
  if (params?.limit) qs.set('limit', String(params.limit));
  const q = qs.toString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>(`/api/audit${q ? `?${q}` : ''}`);
  return raw.entries ?? [];
}

export async function getAuditStats(hours?: number): Promise<import('./types').AuditStats> {
  const qs = hours ? `?hours=${hours}` : '';
  return request(`/api/audit/stats${qs}`);
}

// ---- Files Browser ----
export async function getFileRoots(): Promise<import('./types').FileRoots> {
  return request('/api/files/roots');
}

export async function listFiles(path?: string, root?: string): Promise<import('./types').FileListing> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (root) params.set('root', root);
  const qs = params.toString();
  return request(`/api/files${qs ? `?${qs}` : ''}`);
}

export async function readFile(path: string, root?: string): Promise<import('./types').FileContent> {
  const params = new URLSearchParams({ path });
  if (root) params.set('root', root);
  return request(`/api/files/read?${params}`);
}

export async function writeFile(path: string, content: string, root?: string): Promise<import('./types').FileWriteResult> {
  return request('/api/files/write', { method: 'POST', body: JSON.stringify({ path, content, root }) });
}

export async function createDirectory(path: string, root?: string): Promise<import('./types').FileWriteResult> {
  return request('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ path, root }) });
}

export async function renameFile(oldPath: string, newPath: string, root?: string): Promise<import('./types').FileWriteResult> {
  return request('/api/files/rename', { method: 'POST', body: JSON.stringify({ oldPath, newPath, root }) });
}

export async function deleteFile(path: string, root?: string): Promise<import('./types').FileWriteResult> {
  const params = new URLSearchParams({ path });
  if (root) params.set('root', root);
  return request(`/api/files/delete?${params}`, { method: 'DELETE' });
}

// ---- F5-TTS Voice management ----

export async function getF5TtsStatus(): Promise<{ installed: boolean; running: boolean; voices: string[]; port: number; model: string }> {
  return request('/api/voice/f5tts/status');
}

export async function getAnalyticsProfile(): Promise<{
  installId: string;
  version: string;
  nodeVersion: string;
  os: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  ramTotalMB: number;
  gpuVendor: string;
  gpuName: string;
  installMethod: string;
}> {
  return request('/api/analytics/profile');
}

export async function executeSandbox(code: string, language?: string, timeoutMs?: number): Promise<{
  output: string;
  exitCode: number;
  toolCalls: number;
  durationMs: number;
}> {
  return request('/api/sandbox/execute', {
    method: 'POST',
    body: JSON.stringify({ code, language: language || 'javascript', timeoutMs }),
  });
}

export async function getClonedVoices(): Promise<{ voices: Array<{ name: string; hasTranscript: boolean; sizeBytes: number }> }> {
  return request('/api/voice/clone/voices');
}

export async function uploadVoiceReference(name: string, audioBase64: string, transcript?: string): Promise<{ ok: boolean; voice: string }> {
  return request('/api/voice/clone/upload', {
    method: 'POST',
    body: JSON.stringify({ name, audio: audioBase64, transcript }),
  });
}

export async function deleteClonedVoice(name: string): Promise<{ ok: boolean }> {
  return request(`/api/voice/clone/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function previewVoice(name: string, text?: string): Promise<ArrayBuffer> {
  const body = JSON.stringify({
    text: text || 'Hello, how can I help you today?',
    voice: name,
  });
  const res = await fetch(`${BASE}/api/voice/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body,
  });
  if (!res.ok) throw new Error(`Preview failed: ${res.statusText}`);
  return res.arrayBuffer();
}

// ---- Command Post ----

export async function getCommandPostDashboard(): Promise<CommandPostDashboard> {
  return request('/api/command-post/dashboard');
}

export async function getCommandPostAgents(): Promise<RegisteredAgent[]> {
  return request('/api/command-post/agents');
}

export async function cpCheckoutTask(goalId: string, subtaskId: string, agentId = 'manual'): Promise<TaskCheckout> {
  return request(`/api/command-post/tasks/${goalId}/${subtaskId}/checkout`, {
    method: 'POST', body: JSON.stringify({ agentId }),
  });
}

export async function cpCheckinTask(goalId: string, subtaskId: string, runId: string): Promise<{ success: boolean }> {
  return request(`/api/command-post/tasks/${goalId}/${subtaskId}/checkin`, {
    method: 'POST', body: JSON.stringify({ runId }),
  });
}

export async function getCPBudgets(): Promise<BudgetPolicy[]> {
  return request('/api/command-post/budgets');
}

export async function createCPBudget(policy: Omit<BudgetPolicy, 'id' | 'currentSpend' | 'periodStart'>): Promise<BudgetPolicy> {
  return request('/api/command-post/budgets', {
    method: 'POST', body: JSON.stringify(policy),
  });
}

export async function updateCPBudget(id: string, updates: Partial<BudgetPolicy>): Promise<BudgetPolicy> {
  return request(`/api/command-post/budgets/${id}`, {
    method: 'PUT', body: JSON.stringify(updates),
  });
}

export async function deleteCPBudget(id: string): Promise<{ success: boolean }> {
  return request(`/api/command-post/budgets/${id}`, { method: 'DELETE' });
}

export async function getCPReservations(): Promise<BudgetReservation[]> {
  return request('/api/command-post/budgets/reservations');
}

export async function getIssueContext(issueId: string): Promise<Record<string, unknown>> {
  return request(`/api/command-post/issues/${issueId}/context`);
}

export async function getCPActivity(limit = 50, type?: string): Promise<CPActivityEntry[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (type) params.set('type', type);
  return request(`/api/command-post/activity?${params}`);
}

export async function getCPGoalTree(): Promise<GoalTreeNode[]> {
  return request('/api/command-post/goals/tree');
}

// ---- Paperclip: Org Chart ----

export async function getCPOrg(): Promise<OrgNode[]> {
  return request('/api/command-post/org');
}

// ---- Paperclip: Issues ----

export async function getCPIssues(filters?: { status?: string; assignee?: string; goalId?: string }): Promise<CPIssue[]> {
  const params = new URLSearchParams();
  if (filters?.status) params.set('status', filters.status);
  if (filters?.assignee) params.set('assignee', filters.assignee);
  if (filters?.goalId) params.set('goalId', filters.goalId);
  const qs = params.toString();
  return request(`/api/command-post/issues${qs ? `?${qs}` : ''}`);
}

export async function createCPIssue(opts: { title: string; description?: string; priority?: string; assigneeAgentId?: string; goalId?: string }): Promise<CPIssue> {
  return request('/api/command-post/issues', {
    method: 'POST', body: JSON.stringify(opts),
  });
}

export async function getCPIssue(id: string): Promise<CPIssue> {
  return request(`/api/command-post/issues/${id}`);
}

export async function updateCPIssue(id: string, updates: Partial<CPIssue>): Promise<CPIssue> {
  return request(`/api/command-post/issues/${id}`, {
    method: 'PATCH', body: JSON.stringify(updates),
  });
}

export async function deleteCPIssue(id: string): Promise<{ success: boolean }> {
  return request(`/api/command-post/issues/${id}`, { method: 'DELETE' });
}

export interface CPIssueComment {
  id: string;
  issueId: string;
  authorAgentId?: string;
  authorUser?: string;
  body: string;
  createdAt: string;
}

export async function getCPIssueDetail(issueId: string): Promise<CPIssue & { comments: CPIssueComment[] }> {
  return request(`/api/command-post/issues/${issueId}`);
}

export async function addCPIssueComment(issueId: string, body: string, author: { agentId?: string; user?: string } = {}): Promise<CPIssueComment> {
  return request(`/api/command-post/issues/${issueId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body, ...author }),
  });
}

export async function checkoutCPIssue(issueId: string, agentId: string): Promise<CPIssue> {
  return request(`/api/command-post/issues/${issueId}/checkout`, {
    method: 'POST', body: JSON.stringify({ agentId }),
  });
}

export async function addCPComment(issueId: string, body: string, agentId?: string): Promise<CPComment> {
  return request(`/api/command-post/issues/${issueId}/comments`, {
    method: 'POST', body: JSON.stringify({ body, agentId }),
  });
}

// ---- Paperclip: Approvals ----

export async function getCPApprovals(status?: string): Promise<CPApproval[]> {
  const qs = status ? `?status=${status}` : '';
  return request(`/api/command-post/approvals${qs}`);
}

export async function createCPApproval(opts: { type: string; requestedBy?: string; payload?: Record<string, unknown>; linkedIssueIds?: string[] }): Promise<CPApproval> {
  return request('/api/command-post/approvals', {
    method: 'POST', body: JSON.stringify(opts),
  });
}

export async function approveCPApproval(id: string, decidedBy?: string, note?: string): Promise<CPApproval> {
  return request(`/api/command-post/approvals/${id}/approve`, {
    method: 'POST', body: JSON.stringify({ decidedBy, note }),
  });
}

export async function rejectCPApproval(id: string, decidedBy?: string, note?: string): Promise<CPApproval> {
  return request(`/api/command-post/approvals/${id}/reject`, {
    method: 'POST', body: JSON.stringify({ decidedBy, note }),
  });
}

// ---- Paperclip: Runs ----

export async function getCPRuns(agentId?: string, limit = 50): Promise<CPRun[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (agentId) params.set('agentId', agentId);
  return request(`/api/command-post/runs?${params}`);
}

// ---- Paperclip: Agent Updates ----

export async function updateCPAgent(id: string, updates: { reportsTo?: string; role?: string; title?: string; name?: string; model?: string }): Promise<RegisteredAgent> {
  return request(`/api/command-post/agents/${id}`, {
    method: 'PATCH', body: JSON.stringify(updates),
  });
}

// ---- Traces ----

export async function getTraces(limit = 50, session?: string): Promise<{ traces: import('./types.js').Trace[]; stats: import('./types.js').TraceStats }> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (session) params.set('session', session);
  return request(`/api/traces?${params}`);
}

export async function getTraceDetail(traceId: string): Promise<import('./types.js').Trace> {
  return request(`/api/traces/${traceId}`);
}

// ---- Alerts ----

export async function getAlerts(limit = 50): Promise<{ alerts: import('./types.js').Alert[] }> {
  return request(`/api/alerts?limit=${limit}`);
}

// ---- Soul ----

export async function getSoulWisdom(): Promise<import('./types.js').SoulWisdom> {
  return request('/api/soul/wisdom');
}

export async function getSoulState(sessionId: string): Promise<import('./types.js').SoulState> {
  return request(`/api/soul/state/${sessionId}`);
}

// ---- Guardrails ----

export async function getGuardrailViolations(limit = 50): Promise<{ violations: import('./types.js').GuardrailViolation[] }> {
  return request(`/api/guardrails/violations?limit=${limit}`);
}

// ---- Checkpoints ----

export async function getCheckpoints(): Promise<{ checkpoints: import('./types.js').CheckpointMeta[] }> {
  return request('/api/checkpoints');
}

// ---- Companies ----

export async function listCompanies(): Promise<unknown[]> {
  const data = await request<unknown>('/api/companies');
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && 'companies' in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>).companies as unknown[];
  }
  return [];
}

export async function createCompany(opts: { name: string; mission?: string }): Promise<unknown> {
  return request('/api/companies', { method: 'POST', body: JSON.stringify(opts) });
}

export async function updateCompany(id: string, updates: { name?: string; mission?: string; status?: string }): Promise<unknown> {
  return request(`/api/companies/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function deleteCompany(id: string): Promise<{ success: boolean }> {
  return request(`/api/companies/${id}`, { method: 'DELETE' });
}

// ---- Session Management ----

export async function createSession(): Promise<{ id: string }> {
  return request('/api/sessions', { method: 'POST', body: JSON.stringify({ channel: 'webchat', userId: 'api-user' }) });
}

// ---- Inbox Threading ----

export async function replyToApproval(id: string, author: string, body: string): Promise<CPApproval> {
  return request(`/api/command-post/approvals/${id}/reply`, {
    method: 'POST',
    body: JSON.stringify({ author, body }),
  });
}

export async function snoozeApproval(id: string, until: string): Promise<CPApproval> {
  return request(`/api/command-post/approvals/${id}/snooze`, {
    method: 'POST',
    body: JSON.stringify({ until }),
  });
}

export async function unsnoozeApproval(id: string): Promise<CPApproval> {
  return request(`/api/command-post/approvals/${id}/unsnooze`, {
    method: 'POST',
  });
}

export async function getApprovalThread(id: string): Promise<{ approvalId: string; thread: CPIssueComment[] }> {
  return request(`/api/command-post/approvals/${id}/thread`);
}

export async function batchApprovals(ids: string[], action: 'approve' | 'reject', decidedBy?: string, note?: string): Promise<{ approved?: string[]; rejected?: string[]; failed: string[] }> {
  return request('/api/command-post/approvals/batch', {
    method: 'POST',
    body: JSON.stringify({ ids, action, decidedBy, note }),
  });
}

// ---- Agent Messages ----

export async function getAgentMessages(agentId?: string, userId?: string, unreadOnly?: boolean): Promise<import('./types').AgentMessage[]> {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (userId) params.set('userId', userId);
  if (unreadOnly) params.set('unread', 'true');
  return request(`/api/command-post/agent-messages?${params}`);
}

export async function markAgentMessageRead(id: string): Promise<{ read: boolean }> {
  return request(`/api/command-post/agent-messages/${id}/read`, { method: 'POST' });
}

// ---- Social ----

export async function getSocialState(): Promise<import('./types').SocialState> {
  return request('/api/social/state');
}

export async function toggleSocialAutopilot(enabled: boolean): Promise<{ enabled: boolean }> {
  return request('/api/social/autopilot/toggle', {
    method: 'POST',
    body: JSON.stringify({ enabled }),
  });
}

export async function postSocial(content: string): Promise<{ success: boolean; postId?: string; error?: string; skipped?: string }> {
  return request('/api/social/post', {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
}

export async function approveSocialDraft(id: string): Promise<{ success: boolean; status?: string; postId?: string; error?: string }> {
  return request(`/api/social/drafts/${id}/approve`, { method: 'POST' });
}

export async function rejectSocialDraft(id: string): Promise<{ success: boolean }> {
  return request(`/api/social/drafts/${id}/reject`, { method: 'POST' });
}

export async function getSocialGraphContext(): Promise<{ recentTopics: import('./types').SocialGraphTopic[] }> {
  return request('/api/social/graph-context');
}

// ---- Auth ----

export async function login(password: string): Promise<{ token: string }> {
  return request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

// ---- Backup ----

export async function createBackup(): Promise<{ success: boolean; path?: string; timestamp?: string; error?: string }> {
  return request('/api/backup/create', { method: 'POST' });
}

export async function listBackups(): Promise<{ backups: import('./types').BackupInfo[] }> {
  return request('/api/backup/list');
}

export async function verifyBackup(path?: string): Promise<{ valid: boolean; path: string; error?: string }> {
  return request('/api/backup/verify', {
    method: 'POST',
    body: JSON.stringify(path ? { path } : {}),
  });
}

// ---- Training ----

export async function getTrainingStats(): Promise<import('./types').TrainingStats> {
  return request('/api/training/stats');
}

export async function getTrainingProgress(): Promise<{ runs: import('./types').TrainingRun[] }> {
  return request('/api/training/progress');
}

export async function getTrainingRuns(): Promise<{ runs: import('./types').TrainingRun[] }> {
  return request('/api/training/runs');
}

// ---- Recipes ----

export async function getRecipes(): Promise<{ recipes: import('./types').Recipe[] }> {
  return request('/api/recipes');
}

export async function getRecipe(id: string): Promise<{ recipe: import('./types').Recipe }> {
  return request(`/api/recipes/${id}`);
}

export async function saveRecipe(recipe: import('./types').Recipe): Promise<{ recipe: import('./types').Recipe }> {
  return request('/api/recipes', {
    method: 'POST',
    body: JSON.stringify(recipe),
  });
}

export async function deleteRecipe(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/recipes/${id}`, { method: 'DELETE' });
}

export async function runRecipe(id: string, args?: Record<string, unknown>): Promise<{ success: boolean; runId?: string; error?: string }> {
  return request(`/api/recipes/${id}/run`, {
    method: 'POST',
    body: JSON.stringify(args || {}),
  });
}

// ---- VRAM ----

export async function getVramSnapshot(): Promise<import('./types').VramSnapshot> {
  return request('/api/vram');
}

export async function acquireVram(service: string, requiredMB: number, leaseDurationMs?: number): Promise<{ leaseId: string; grantedMB: number; error?: string }> {
  return request('/api/vram/acquire', {
    method: 'POST',
    body: JSON.stringify({ service, requiredMB, leaseDurationMs }),
  });
}

export async function releaseVram(leaseId: string, restoreModel = true): Promise<{ released: boolean; error?: string }> {
  return request('/api/vram/release', {
    method: 'POST',
    body: JSON.stringify({ leaseId, restoreModel }),
  });
}

// ---- Teams ----

export async function getTeams(): Promise<{ teams: import('./types').Team[] }> {
  return request('/api/teams');
}

export async function createTeam(name: string, description?: string): Promise<{ team: import('./types').Team }> {
  return request('/api/teams', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
}

export async function deleteTeam(teamId: string): Promise<{ deleted: boolean }> {
  return request(`/api/teams/${teamId}`, { method: 'DELETE' });
}

// ---- Cron ----

export async function getCronJobs(): Promise<{ jobs: import('./types').CronJob[] }> {
  return request('/api/cron');
}

export async function createCronJob(job: Omit<import('./types').CronJob, 'id'>): Promise<{ job: import('./types').CronJob }> {
  return request('/api/cron', {
    method: 'POST',
    body: JSON.stringify(job),
  });
}

export async function toggleCronJob(id: string): Promise<{ job: import('./types').CronJob }> {
  return request(`/api/cron/${id}/toggle`, { method: 'POST' });
}

export async function deleteCronJob(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/cron/${id}`, { method: 'DELETE' });
}

// ---- Checkpoints ----

export async function deleteCheckpoint(sessionId: string): Promise<{ deleted: boolean }> {
  return request(`/api/checkpoints/${sessionId}`, { method: 'DELETE' });
}

// ---- Organism ----

export async function getOrganismAlerts(): Promise<{ alerts: import('./types').Alert[] }> {
  return request('/api/organism/alerts');
}

export async function getOrganismAlertStats(): Promise<{ total: number; acked: number; unacked: number }> {
  return request('/api/organism/alerts/stats');
}

export async function getOrganismSafetyMetrics(): Promise<Record<string, number>> {
  return request('/api/organism/safety-metrics');
}

export async function getOrganismHistory(): Promise<{ history: Array<{ timestamp: string; event: string; data: unknown }> }> {
  return request('/api/organism/history');
}

export async function acknowledgeAlert(id: string): Promise<{ success: boolean }> {
  return request(`/api/organism/alerts/${id}/acknowledge`, { method: 'POST' });
}

// ---- Fleet ----

export async function getFleet(): Promise<{ nodes: import('./types').FleetNode[] }> {
  return request('/api/fleet');
}

export async function routeFleet(target: string, payload?: unknown): Promise<{ routed: boolean; nodeId?: string; error?: string }> {
  return request('/api/fleet/route', {
    method: 'POST',
    body: JSON.stringify({ target, payload }),
  });
}

// ---- Browser ----

export async function solveCaptcha(imageBase64: string, provider?: string): Promise<{ success: boolean; token?: string; error?: string }> {
  return request('/api/browser/solve-captcha', {
    method: 'POST',
    body: JSON.stringify({ imageBase64, provider }),
  });
}

// ---- Paperclip ----

export async function getPaperclipStatus(): Promise<{ running: boolean; pid?: number; url?: string; error?: string }> {
  return request('/api/paperclip/status');
}

export async function startPaperclip(): Promise<{ success: boolean; pid?: number; error?: string }> {
  return request('/api/paperclip/start', { method: 'POST' });
}

export async function stopPaperclip(): Promise<{ success: boolean; error?: string }> {
  return request('/api/paperclip/stop', { method: 'POST' });
}

// ---- Test Health ----

export async function getTestHealthSummary(): Promise<{ total: number; passing: number; failing: number; flaky: number; coverage?: number }> {
  return request('/api/test-health/summary');
}

export async function getFailingTests(): Promise<{ tests: import('./types').FailingTest[] }> {
  return request('/api/test-health/failing');
}

export async function getFlakyTests(): Promise<{ tests: import('./types').FlakyTest[] }> {
  return request('/api/test-health/flaky');
}

export async function getTestHistory(): Promise<{ runs: import('./types').TestRunRecord[] }> {
  return request('/api/test-health/history');
}

export async function runTests(scope?: string): Promise<{ runId: string; started: boolean }> {
  return request('/api/test-health/run', {
    method: 'POST',
    body: JSON.stringify(scope ? { scope } : {}),
  });
}
