// ---- Chat / Messages ----
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  toolsUsed?: string[];
  model?: string;
  durationMs?: number;
}

export interface SendMessageRequest {
  content: string;
  sessionId?: string;
  model?: string;
}

export interface SendMessageResponse {
  content: string;
  sessionId: string;
  toolsUsed: string[];
  durationMs: number;
  model: string;
}

// ---- SSE streaming ----
export interface StreamEvent {
  type: 'token' | 'tool_start' | 'tool_end' | 'done' | 'error';
  data: string;
  toolName?: string;
  sessionId?: string;
  model?: string;
  durationMs?: number;
  toolsUsed?: string[];
}

// ---- Sessions ----
export interface Session {
  id: string;
  name?: string;
  createdAt: string;
  messageCount: number;
  lastMessage?: string;
}

// ---- Config ----
export interface TitanConfig {
  model: string;
  provider: string;
  voice: VoiceConfig;
  agent?: { model: string; provider?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface VoiceConfig {
  enabled: boolean;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  agentUrl: string;
  ttsVoice: string;
  ttsEngine?: string;
  ttsUrl?: string;
  sttUrl?: string;
}

// ---- Health ----
export interface HealthStatus {
  status: 'ok' | 'error';
  uptime: number;
  version: string;
}

export interface VoiceHealth {
  livekit: boolean;
  stt: boolean;
  tts: boolean;
  agent: boolean;
  overall: boolean;
  ttsEngine?: string;
}

// ---- Stats ----
export interface SystemStats {
  uptime: number;
  totalRequests: number;
  activeAgents: number;
  activeSessions: number;
  memoryUsage: NodeJS.MemoryUsage;
  version: string;
  model: string;
  provider: string;
}

// ---- Agents ----
export interface AgentInfo {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'error';
  model?: string;
  createdAt: string;
  messageCount: number;
}

// ---- Skills ----
export interface SkillInfo {
  name: string;
  description: string;
  enabled: boolean;
  category: string;
}

// ---- Tools ----
export interface ToolInfo {
  name: string;
  description: string;
  category: string;
  parameters?: Record<string, unknown>;
}

// ---- Channels ----
export interface ChannelInfo {
  name: string;
  type: string;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
}

export interface ChannelConfig {
  enabled: boolean;
  token?: string;
  apiKey?: string;
  allowFrom: string[];
  dmPolicy: 'pairing' | 'open' | 'closed';
}

// ---- Mesh ----
export interface MeshPeer {
  id: string;
  nodeId: string;
  url: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  name?: string;
  connectedAt?: string;
}

// ---- LiveKit Token ----
export interface LiveKitTokenResponse {
  serverUrl: string;
  roomName: string;
  participantName: string;
  participantToken: string;
}

// ---- Logs ----
export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

// ---- Personas ----
export interface PersonaMeta {
  id: string;
  name: string;
  description: string;
  division: string;
  source?: string;
}

// ---- Activity ----
export interface ActivityEvent {
  timestamp: string;
  level: string;
  component: string;
  message: string;
  type: string; // tool, agent, autopilot, goal, search, autonomy, router, graph, error, system
}

export interface ActivityGoalSummary {
  id: string;
  title: string;
  progress: number;
}

export interface ActivitySummary {
  activeSessions: number;
  toolCallsLast24h: number;
  autopilotRunsToday: number;
  autopilotEnabled: boolean;
  autopilotNextRun: string | null;
  activeGoals: number;
  goals: ActivityGoalSummary[];
  lastActivity: string | null;
  currentModel: string;
  autonomyMode: string;
  status: 'idle' | 'processing' | 'autopilot';
  graphStats: { entities: number; edges: number };
}

// ---- Models ----
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  available: boolean;
}

// ---- Autoresearch ----
export interface AutoresearchRun {
  timestamp: string;
  val_score: number;
  hyperparams: {
    lr: number;
    rank: number;
    alpha: number;
    dropout: number;
    epochs: number;
    batch_size: number;
    grad_accum: number;
    max_seq_len: number;
  };
  training_time_s: number;
  num_examples: number;
  adapter_path: string;
}

export interface AutoresearchPerformance {
  totalRuns: number;
  bestScore: number;
  avgImprovement: number;
  baseline: number;
  lastRun?: AutoresearchRun;
}

/** Alias matching the results.json shape */
export interface AutoresearchResult {
  timestamp: string;
  val_score: number;
  hyperparams: Record<string, number>;
  training_time_s: number;
  num_examples: number;
  adapter_path: string;
  type?: 'tool_router' | 'agent';
}

export interface AutoresearchSummary {
  totalRuns: number;
  bestScore: number;
  avgImprovement: number;
  lastRunTime: string | null;
  isRunning: boolean;
}

// ---- MCP ----
export interface McpServerInfo {
  id: string;
  name: string;
  description: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error';
  toolCount: number;
}

export interface McpPreset {
  id: string;
  name: string;
  description: string;
  type: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
}

// ---- Daemon ----
export interface DaemonStatus {
  running: boolean;
  startedAt: string | null;
  uptimeMs: number;
  activeWatchers: string[];
  actionsThisHour: number;
  maxActionsPerHour: number;
  errorRatePercent: number;
  paused: boolean;
  pauseReason: string | null;
}

// ---- Audit Log ----
export interface AuditEntry {
  timestamp: string;
  action: string;
  source: string;
  tool?: string;
  args?: Record<string, unknown>;
  result?: 'success' | 'failure' | 'escalated';
  detail?: Record<string, unknown>;
  durationMs?: number;
  cost?: number;
}

export interface AuditStats {
  totalActions: number;
  bySource: Record<string, number>;
  byAction: Record<string, number>;
  successRate: number;
  topTools: Array<{ tool: string; count: number }>;
}

// ---- Files Browser ----
export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

export interface FileListing {
  path: string;
  entries: FileEntry[];
  basePath: string;
}

export interface FileContent {
  path: string;
  content: string;
  truncated: boolean;
  size: number;
  modified: string;
}

export type TrainingType = 'tool_router' | 'main_agent';

export interface TrainingConfig {
  baseModel: string;
  loraRank: number;
  learningRate: number;
  epochs: number;
  timeBudgetMin: number;
  maxSeqLength: number;
}
