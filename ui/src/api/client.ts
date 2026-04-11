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
  options?: { agentId?: string },
): Promise<void> {
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
                    onEvent?.({ type: 'tool_end', data: '', toolName: parsed.name, toolResult: parsed.result, toolDurationMs: parsed.durationMs, toolSuccess: parsed.success });
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
export async function listFiles(path?: string): Promise<import('./types').FileListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  return request(`/api/files${qs}`);
}

export async function readFile(path: string): Promise<import('./types').FileContent> {
  return request(`/api/files/read?path=${encodeURIComponent(path)}`);
}

// ---- Orpheus TTS management ----

export async function getOrpheusStatus(): Promise<{ installed: boolean; running: boolean; venvPath: string }> {
  return request('/api/voice/orpheus/status');
}

export async function startOrpheus(): Promise<{ ok: boolean }> {
  return request('/api/voice/orpheus/start', { method: 'POST' });
}

export async function stopOrpheus(): Promise<{ ok: boolean }> {
  return request('/api/voice/orpheus/stop', { method: 'POST' });
}

// ---- Qwen3-TTS Voice Cloning management ----

export async function getQwen3TtsStatus(): Promise<{ installed: boolean; running: boolean; voices: string[]; port: number; model: string }> {
  return request('/api/voice/qwen3tts/status');
}

export async function startQwen3Tts(): Promise<{ ok: boolean }> {
  return request('/api/voice/qwen3tts/start', { method: 'POST' });
}

export async function stopQwen3Tts(): Promise<{ ok: boolean }> {
  return request('/api/voice/qwen3tts/stop', { method: 'POST' });
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

export async function cpCheckinTask(subtaskId: string, runId: string): Promise<{ success: boolean }> {
  return request(`/api/command-post/tasks/${subtaskId}/checkin`, {
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

export async function updateCPAgent(id: string, updates: { reportsTo?: string; role?: string; title?: string; name?: string }): Promise<RegisteredAgent> {
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

// ---- Session Management ----

export async function createSession(): Promise<{ id: string }> {
  return request('/api/sessions', { method: 'POST', body: JSON.stringify({ channel: 'webchat', userId: 'api-user' }) });
}

// ---- Auth ----

export async function login(password: string): Promise<{ token: string }> {
  return request('/api/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}
