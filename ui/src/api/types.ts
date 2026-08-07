// ---- Tool Invocation ----
export interface ToolInvocation {
  toolName: string;
  status: 'running' | 'success' | 'error';
  args?: Record<string, unknown>;
  result?: string;
  diff?: string;
  durationMs?: number;
  startedAt: number;
  endedAt?: number;
}

// ---- Chat / Messages ----
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  toolsUsed?: string[];
  toolInvocations?: ToolInvocation[];
  model?: string;
  durationMs?: number;
  /** True when this message is a plan waiting for user approve/deny */
  pendingApproval?: boolean;
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
  type: 'token' | 'tool_start' | 'tool_end' | 'thinking' | 'round' | 'done' | 'error' | 'widget';
  data: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolDiff?: string;
  toolSuccess?: boolean;
  toolDurationMs?: number;
  round?: number;
  maxRounds?: number;
  sessionId?: string;
  model?: string;
  durationMs?: number;
  toolsUsed?: string[];
  // Structured error fields from classifyChatError (P0-4)
  errorCode?: string;
  errorMessage?: string;
  errorAction?: { type: string; target: string; label: string };
  // Plan approval: true when the response is a plan waiting for user approve/deny
  pendingApproval?: boolean;
  // Canvas widget side-channel (v5.8.x). When type==='widget' the consumer
  // should route the event into SpaceEngine (create / update / remove)
  // without parsing the assistant text. See src/agent/widgetEmitter.ts.
  widgetMode?: 'create' | 'update' | 'remove';
  widget?: Record<string, unknown>;
  timestamp?: number;
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
  // v4.6.1: channel identifies whether the session is a user chat
  // ('webchat', 'messenger-admin', 'twilio-admin'...) or an internal
  // thought-train ('initiative', 'deliberation', etc.). Used by
  // ChatView to hide internal sessions from the drawer.
  channel?: string;
  userId?: string;
  agentId?: string;
  status?: string;
  lastActive?: string;
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

// ---- Social ----
export interface SocialAutopilotState {
  enabled: boolean;
  postsToday: number;
  maxPostsPerDay: number;
  repliesToday: number;
  lastPostAt: string | null;
  nextContentType: string;
}

export interface SocialQueuedPost {
  id: string;
  content: string;
  status: string;
  createdAt: string;
  method?: string;
}

export interface SocialRecentPost {
  date: string;
  type: string;
  postId?: string;
  content?: string;
}

export interface SocialState {
  autopilot: SocialAutopilotState;
  queue: SocialQueuedPost[];
  recentPosts: SocialRecentPost[];
}

export interface SocialGraphTopic {
  content: string;
  date: string;
  entities: string[];
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

export interface FileRoots {
  roots: Array<{ label: string; path: string }>;
}

export interface FileWriteResult {
  success: boolean;
  path: string;
  size?: number;
  modified?: string;
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
  // F2: Persistent identity
  voiceId?: string;
  personaId?: string;
  systemPromptOverride?: string;
  memoryNamespace?: string;
  characterSummary?: string;
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
  type: 'hire_agent' | 'budget_override' | 'goal_proposal' | 'soma_proposal' | 'custom';
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  payload: Record<string, unknown>;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  linkedIssueIds: string[];
  createdAt: string;
  thread?: CPComment[];
  snoozedUntil?: string;
}

export interface AgentMessage {
  id: string;
  agentId: string;
  agentName: string;
  userId: string;
  content: string;
  context?: Record<string, unknown>;
  read: boolean;
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

// ---- Execution Traces ----

export interface TraceSpan {
  name: string;
  startMs: number;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface TraceToolCall {
  tool: string;
  args: Record<string, unknown>;
  durationMs: number;
  success: boolean;
  round: number;
}

export interface Trace {
  traceId: string;
  sessionId: string;
  message: string;
  startedAt: string;
  endedAt?: string;
  totalMs?: number;
  spans: TraceSpan[];
  toolCalls: TraceToolCall[];
  rounds: number;
  model?: string;
  tokens?: { prompt: number; completion: number };
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

export interface TraceStats {
  totalTraces: number;
  running: number;
  avgDurationMs: number;
  avgRounds: number;
  avgToolCalls: number;
  topTools: Array<{ tool: string; count: number }>;
}

// ---- Soul ----

export interface SoulState {
  taskUnderstanding: string;
  confidence: 'high' | 'medium' | 'low' | 'lost';
  strategy: 'direct' | 'explore' | 'plan' | 'ask_user' | 'delegate';
  attempts: string[];
  insights: string[];
  round: number;
  toolsUsed: string[];
  updatedAt: string;
}

export interface SoulWisdom {
  patterns: Array<{ taskType: string; bestStrategy: string; avgRounds: number; successRate: number; learnedAt: string }>;
  mistakes: Array<{ description: string; avoidance: string; learnedAt: string }>;
  totalTasks: number;
  avgConfidence: number;
  lastUpdated: string;
}

// ---- Alerts ----

export interface Alert {
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  source: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

// ---- Guardrails ----

export interface GuardrailViolation {
  timestamp: string;
  layer: 'input' | 'tool' | 'output';
  rule: string;
  severity: 'info' | 'warning' | 'critical';
  content: string;
  blocked: boolean;
}

// ---- Checkpoints ----

export interface CheckpointMeta {
  sessionId: string;
  rounds: number;
  latestRound: number;
  model: string;
  message: string;
  channel: string;
  createdAt: string;
  updatedAt: string;
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

// ---- v8 Company Room (Slice 1) ----

/**
 * A single signed event in the v8 company append-only event log.
 * Kinds (Slice 1): company.created, agent.minted, room.message,
 * task.delegated, task.result, task.checked.
 *
 * Signature covers the canonical envelope: id | prevHash | kind | ts | actor | payload
 * (per Fizz's chain binding — sha256 of prev sig+id, 'genesis' for first event).
 */
export interface CompanyEvent {
  /** Total order sequence number (SQLite AUTOINCREMENT) */
  seq: number;
  /** UUID */
  id: string;
  /** Event kind — slice-1 kinds plus slice-2 queue kinds (when queue.enabled) */
  kind: 'company.created' | 'agent.minted' | 'room.message' | 'task.delegated' | 'task.result' | 'task.checked'
    | 'task.started' | 'task.retry' | 'task.blocked' | 'task.unblocked'
    | 'hold.set' | 'hold.lifted' | 'commitment.opened' | 'commitment.closed';
  /** ms epoch */
  ts: number;
  /** agent id (pubkey hex) or 'user' */
  actor: string;
  /** ed25519 signature over canonical envelope (id | prevHash | kind | ts | actor | payload) */
  sig: string;
  /** Hash of previous event (sha256 of prev sig+id), 'genesis' for first */
  prevHash: string;
  /** JSON, kind-specific */
  payload: Record<string, unknown>;
}

/**
 * Agent in the v8 company crew.
 * Wire contract matches service.ts:getCompanyStatus exactly:
 * { agentId, displayName, role, charter }.
 */
export interface CompanyAgent {
  /** Agent pubkey hex — the identity key from mint */
  agentId: string;
  /** Human-readable name from the persona pack */
  displayName: string;
  /** Role in the company (CEO, Builder, Scout, etc.) */
  role: string;
  /** Charter / system prompt from persona pack */
  charter: string;
}

/** Company status response from GET /api/company */
export interface CompanyStatus {
  exists: boolean;
  name?: string;
  mission?: string;
  createdAt?: number;
  agents: CompanyAgent[];
  eventCount: number;
}

/** Paged room events response from GET /api/company/room */
export interface CompanyRoomPage {
  events: CompanyEvent[];
  after: number;
  limit: number;
}

// ---- v8 Work Queue (Slice 2) ----

/**
 * Task slot state in the work queue.
 * Derived from the event log fold — never self-reported.
 *
 * State machine (per V8_SLICE2_DESIGN.md):
 *   queued → running → done (checked)
 *                 ↗ blocked → unblocked → running
 *   queued → held → (lifted) → queued
 *   any nonterminal → discarded (maintenance only)
 */
export type QueueSlotState =
  | 'queued'
  | 'running'
  | 'blocked'
  | 'held'
  | 'done'
  | 'discarded';

/**
 * A single task slot in the work queue, derived from the event log fold.
 * The queue is one-lane: at most one slot is 'running' at a time.
 */
export interface QueueSlot {
  /** Slot number (sequential, from the task.delegated event order) */
  slot: number;
  /** Event id of the originating task.delegated event */
  taskRef: string;
  /** Current state of the slot */
  state: QueueSlotState;
  /** Task spec text from the delegation */
  spec: string;
  /** Owner agent id (pubkey hex) or 'user' */
  owner: string;
  /** Owner display name (resolved by the backend from crew) */
  ownerName?: string;
  /** Owner role */
  ownerRole?: string;
  /** Current attempt number (starts at 1) */
  attempt: number;
  /** Previous attempt verdict if retried (e.g. 'needs-work') */
  prevVerdict?: string;
  /** ms epoch when the slot entered its current state */
  stateSince: number;
  /** True if the owner's model quota is exhausted / cannot start */
  ownerUnavailable?: boolean;
  /** Reason text if owner is unavailable */
  ownerUnavailableReason?: string;
  /** Block info if state is 'blocked' */
  block?: {
    /** Event id of the task.blocked event */
    blockRef: string;
    /** Who set the block: 'watchman' | 'owner' */
    setter: string;
    /** Reason: 'stalled' | custom */
    reason: string;
    /** ms epoch when the block was set */
    at: number;
    /** True if the supervisor can auto-clear this (watchman stalled) */
    autoClearable?: boolean;
  };
  /** Hold info if state is 'held' */
  hold?: {
    /** Event id of the hold.set event */
    holdRef: string;
    /** Who set the hold: 'user' | 'watchman' */
    setter: string;
    /** Reason text */
    reason: string;
    /** ms epoch when the hold was set */
    at: number;
  };
  /** Check verdict if state is 'done' */
  verdict?: string;
  /** Check note if state is 'done' */
  verdictNote?: string;
  /** Last receipt/evidence description (e.g. "file written · 2 min ago") */
  lastEvidence?: string;
}

/**
 * Agent presence derived from queue state + receipts.
 * Per V8_SLICE2_DESIGN.md §6: pure presenceAt(now) — never self-reported.
 * Priority: blocked > stuck > working > waiting > idle
 */
export type PresenceStatus = 'working' | 'blocked' | 'stuck' | 'waiting' | 'idle';

/**
 * Derived presence for a single crew member.
 */
export interface QueuePresence {
  /** Agent id (pubkey hex) */
  agentId: string;
  /** Display name from crew */
  displayName: string;
  /** Role from crew */
  role: string;
  /** Derived presence status */
  status: PresenceStatus;
  /** What the agent is currently doing (derived from queue slot) */
  activity: string;
  /** Human-readable derivation note (e.g. "last receipt 2 min ago") */
  derived: string;
}

/**
 * A commitment (first-class open/closed event).
 * Per V8_ARCHITECTURE.md §2.5.1: "I'll loop back on X" creates an obligation.
 */
export interface QueueCommitment {
  /** Event id of the commitment.opened event */
  id: string;
  /** Agent who made the commitment */
  agent: string;
  /** Agent display name */
  agentName?: string;
  /** Commitment text */
  text: string;
  /** ms epoch when opened */
  openedAt: number;
  /** ms epoch deadline, if set */
  dueAt?: number;
  /** True if overdue (derived: now > dueAt and not closed) */
  overdue?: boolean;
  /** True if closed */
  closed: boolean;
  /** ms epoch when closed, if closed */
  closedAt?: number;
  /** Close note */
  closeNote?: string;
}

/**
 * Work queue fold — the response from GET /api/company/queue.
 * This is the fold over the event log: slots with their derived states,
 * commitments, and counts. Per V8_SLICE2_DESIGN.md §8 build order step 5:
 * "GET /api/company/queue returns the fold."
 */
export interface QueueFold {
  /** All slots in slot order (active first, then done) */
  slots: QueueSlot[];
  /** Open commitments (sorted: overdue first, then by openedAt) */
  commitments: QueueCommitment[];
  /** Count of running slots (0 or 1 — one-lane queue) */
  runningCount: number;
  /** Count of queued slots */
  queuedCount: number;
  /** Count of blocked slots */
  blockedCount: number;
  /** Count of held slots */
  heldCount: number;
  /** Count of done slots */
  doneCount: number;
  /** Count of open commitments */
  openCommitments: number;
  /** Count of overdue commitments */
  overdueCommitments: number;
  /** True if the lane is busy (a slot is running) */
  laneBusy: boolean;
  /** Name of the agent currently in the lane, if any */
  laneOwner?: string;
}

/**
 * Presence derivation response from GET /api/company/presence?now=.
 * Per V8_SLICE2_DESIGN.md §8: "GET /api/company/presence?now= the derivation."
 * Pure presenceAt(now) — owner-authored allowlist liveness, never self-reported.
 */
export interface QueuePresenceResponse {
  /** Derived presence for all crew members */
  presence: QueuePresence[];
  /** The `now` timestamp the derivation was computed at (ms epoch) */
  now: number;
}

// ---- Backup ----

export interface BackupManifest {
  version: string;
  createdAt: string;
  files: Array<{ name: string; size: number; hash?: string }>;
  titanVersion: string;
}

export interface BackupInfo {
  filename: string;
  path: string;
  createdAt: string;
  sizeBytes: number;
  manifest?: BackupManifest;
}

// ---- Training ----

export interface TrainingStats {
  entries: number;
  sizeBytes: number;
  lastCapture: string | null;
}

export interface TrainingRun {
  id: string;
  type: 'tool_router' | 'main_agent';
  status: 'running' | 'completed' | 'failed' | 'pending';
  startedAt: string;
  completedAt?: string;
  examplesProcessed: number;
  accuracy?: number;
  loss?: number;
}

// ---- Recipes ----

export interface RecipeStep {
  prompt: string;
  tool?: string;
  toolArgs?: Record<string, unknown>;
  awaitConfirm?: boolean;
}

export interface Recipe {
  id: string;
  name: string;
  description: string;
  slashCommand?: string;
  parameters?: Record<string, {
    description: string;
    required: boolean;
    default?: string;
  }>;
  steps: RecipeStep[];
  author?: string;
  tags?: string[];
  createdAt: string;
  lastRunAt?: string;
}

// ---- Teams ----

export type TeamRole = 'owner' | 'admin' | 'operator' | 'viewer';
export type MemberStatus = 'pending' | 'active' | 'suspended' | 'revoked';

export interface TeamMember {
  userId: string;
  role: TeamRole;
  status: MemberStatus;
  joinedAt: string;
  invitedBy: string;
  displayName?: string;
  lastActive?: string;
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  members: TeamMember[];
  ownerId: string;
}

// ---- Cron ----

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
}

// ---- VRAM ----

export interface GpuState {
  vendor: 'nvidia' | 'amd' | 'apple' | 'none';
  totalMB: number;
  usedMB: number;
  freeMB: number;
  temperatureC: number;
  utilizationPct: number;
  driverVersion: string;
  gpuName: string;
  unifiedMemory: boolean;
}

export interface LoadedModel {
  name: string;
  sizeMB: number;
  sizeVramMB: number;
  family: string;
  parameterSize: string;
  quantization: string;
  expiresAt: string;
}

export interface VramLease {
  id: string;
  service: string;
  reservedMB: number;
  createdAt: number;
  expiresAt: number;
  evictedModel?: string;
  replacementModel?: string;
}

export interface VramSnapshot {
  gpu: GpuState;
  loadedModels: LoadedModel[];
  activeLeases: VramLease[];
  reservedMB: number;
  availableMB: number;
}

// ---- Fleet ----

export interface FleetNode {
  id: string;
  name: string;
  address: string;
  status: 'online' | 'offline' | 'busy';
  capabilities: string[];
  lastSeen: string;
  load?: number;
}

// ---- Tests ----

export interface FailingTest {
  name: string;
  suite: string;
  error: string;
  lastFailed: string;
  attempts: number;
}

export interface FlakyTest {
  name: string;
  suite: string;
  passRate: number;
  runs: number;
}

export interface TestRunRecord {
  timestamp: string;
  status: string;
  passed: number;
  failed: number;
  failingTests: string[];
  durationMs: number;
}

// ---- Organism ----


