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
}

// ---- Agent Watcher ----
export interface AgentEvent {
  id: string;
  type: 'tool_start' | 'tool_end' | 'thinking' | 'token' | 'round' | 'done';
  toolName?: string;
  args?: Record<string, unknown>;
  result?: string;
  durationMs?: number;
  status?: 'running' | 'success' | 'error';
  round?: number;
  maxRounds?: number;
  timestamp: number;
  agentName?: string;
  isSubAgent?: boolean;
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

// ---- Command Post (Agent Governance) ----

export interface TaskCheckout {
  subtaskId: string;
  goalId: string;
  agentId: string;
  runId: string;
  checkedOutAt: string;
  expiresAt: string;
  status: 'locked' | 'released' | 'expired';
}

export interface BudgetPolicy {
  id: string;
  name: string;
  scope: { type: 'agent' | 'goal' | 'global'; targetId?: string };
  period: 'daily' | 'weekly' | 'monthly';
  limitUsd: number;
  warningThresholdPercent: number;
  action: 'warn' | 'pause' | 'stop';
  currentSpend: number;
  periodStart: string;
  enabled: boolean;
}

export interface RegisteredAgent {
  id: string;
  name: string;
  model: string;
  status: 'active' | 'idle' | 'paused' | 'error' | 'stopped';
  lastHeartbeat: string;
  currentTaskId?: string;
  totalTasksCompleted: number;
  totalCostUsd: number;
  createdAt: string;
  reportsTo?: string;
  role: 'ceo' | 'manager' | 'engineer' | 'researcher' | 'general';
  title?: string;
}

export interface CPActivityEntry {
  id: string;
  timestamp: string;
  type: string;
  agentId?: string;
  goalId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface BudgetReservation {
  id: string;
  policyId: string;
  agentId: string;
  goalId?: string;
  amountUsd: number;
  estimatedUsd: number;
  actualUsd?: number;
  status: 'reserved' | 'settled' | 'cancelled';
  reason: string;
  createdAt: string;
  expiresAt: string;
}

export interface GoalTreeNode {
  goal: { id: string; title: string; status: string; progress: number; parentGoalId?: string; description?: string; updatedAt?: string; createdAt?: string };
  children: GoalTreeNode[];
  depth: number;
}

export interface CommandPostDashboard {
  activeAgents: number;
  totalAgents: number;
  activeCheckouts: number;
  budgetUtilization: number;
  recentActivity: CPActivityEntry[];
  agents: RegisteredAgent[];
  checkouts: TaskCheckout[];
  budgets: BudgetPolicy[];
  goalTree: GoalTreeNode[];
}

// ---- Paperclip: Issues ----

export interface CPIssue {
  id: string;
  title: string;
  description: string;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
  priority: 'critical' | 'high' | 'medium' | 'low';
  assigneeAgentId?: string;
  createdByAgentId?: string;
  createdByUser?: string;
  goalId?: string;
  parentId?: string;
  checkoutRunId?: string;
  issueNumber: number;
  identifier: string;
  comments?: CPComment[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CPComment {
  id: string;
  issueId: string;
  authorAgentId?: string;
  authorUser?: string;
  body: string;
  createdAt: string;
}

// ---- Paperclip: Approvals ----

export interface CPApproval {
  id: string;
  type: 'hire_agent' | 'budget_override' | 'custom';
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  payload: Record<string, unknown>;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  linkedIssueIds: string[];
  createdAt: string;
}

// ---- Paperclip: Runs ----

export interface CPRun {
  id: string;
  agentId: string;
  source: 'heartbeat' | 'assignment' | 'manual' | 'autopilot';
  status: 'running' | 'succeeded' | 'failed' | 'error';
  issueId?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  toolsUsed: string[];
  tokenUsage?: { prompt: number; completion: number };
  error?: string;
}

// ---- Paperclip: Org Chart ----

export interface OrgNode {
  id: string;
  name: string;
  role: string;
  title?: string;
  status: string;
  model: string;
  reports: OrgNode[];
}
