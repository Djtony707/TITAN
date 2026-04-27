/**
 * TITAN Configuration Schema â Zod-based validation with full type inference
 */
import { z } from 'zod';
import {
    DEFAULT_GATEWAY_HOST,
    DEFAULT_GATEWAY_PORT,
    DEFAULT_WEB_PORT,
    DEFAULT_MODEL,
    DEFAULT_MAX_TOKENS,
    DEFAULT_TEMPERATURE,
    DEFAULT_SANDBOX_MODE,
    ALLOWED_TOOLS_DEFAULT,
} from '../utils/constants.js';

export const AuthProfileSchema = z.object({
    name: z.string(),
    apiKey: z.string(),
    priority: z.number().default(0),
});

export const ProviderConfigSchema = z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    maxTokens: z.number().optional(),
    temperature: z.number().min(0).max(2).optional(),
    /** Multiple API keys with automatic failover */
    authProfiles: z.array(AuthProfileSchema).default([]),
    /** Credential rotation strategy when multiple authProfiles are configured */
    rotationStrategy: z.enum(['priority', 'round-robin', 'least-used']).default('priority'),
    /** Cooldown duration in ms when a credential is exhausted (default: 60s) */
    credentialCooldownMs: z.number().default(60000),
    /** v5.0: Credential pool — multiple API keys for same provider with automatic rotation */
    credentialPool: z.object({
        apiKeys: z.array(z.string()).default([]),
        rotationStrategy: z.enum(['least_used', 'round_robin', 'random']).default('least_used'),
    }).optional(),
    /** v5.0: Transport layer override ('anthropic' | 'chat_completions' | 'responses_api' | 'bedrock') */
    transport: z.enum(['anthropic', 'chat_completions', 'responses_api', 'bedrock']).optional(),
});

export const ChannelConfigSchema = z.object({
    enabled: z.boolean().default(false),
    token: z.string().optional(),
    apiKey: z.string().optional(),
    allowFrom: z.array(z.string()).default([]),
    dmPolicy: z.enum(['pairing', 'open', 'closed']).default('pairing'),
});

/**
 * v4.3.2: Messenger channel extends the base config with voice-reply options.
 * When enabled, owner messages get synthesized in the configured voice via
 * F5-TTS (default: Andrew). Falls back to text cleanly if TTS/upload fails.
 */
export const MessengerChannelConfigSchema = ChannelConfigSchema.extend({
    voiceReplies: z.object({
        enabled: z.boolean().default(true),
        voice: z.string().default('andrew'),
        /** Cap synthesized audio length to avoid huge uploads */
        maxChars: z.number().default(1000),
    }).default({ enabled: true, voice: 'andrew', maxChars: 1000 }),
});

export const SecurityConfigSchema = z.object({
    sandboxMode: z.enum(['host', 'docker', 'none']).default(DEFAULT_SANDBOX_MODE as 'host'),
    allowedTools: z.array(z.string()).default(ALLOWED_TOOLS_DEFAULT),
    deniedTools: z.array(z.string()).default([]),
    maxConcurrentTasks: z.number().default(5),
    commandTimeout: z.number().default(30000),
    /** Per-tool timeout overrides (ms) â keys are tool names */
    toolTimeouts: z.record(z.string(), z.number()).default({
        browser_auto_nav: 60000,
        browser_navigate: 60000,
        web_fetch: 45000,
        web_search: 45000,
        web_act: 60000,
        smart_form_fill: 60000,
        shell: 60000,
        code_exec: 120000,
        self_improve_start: 1800000,     // 30 minutes â runs full experiment loop
        self_improve_apply: 60000,
        train_prepare: 300000,           // 5 minutes â scans session history
        train_start: 7200000,            // 2 hours â GPU fine-tuning
        train_deploy: 600000,            // 10 minutes â GGUF conversion + Ollama import
    }),
    /** Automatic retry for transient tool failures */
    toolRetry: z.object({
        enabled: z.boolean().default(true),
        maxRetries: z.number().default(3),
        backoffBaseMs: z.number().default(1000),
    }).default({}),
    fileSystemAllowlist: z.array(z.string()).default([]),
    networkAllowlist: z.array(z.string()).default(['*']),
    shield: z.object({
        enabled: z.boolean().default(true),
        mode: z.enum(['standard', 'strict']).default('strict'),
    }).default({}),
    maxMemoryMB: z.number().default(2048),
    maxSubprocesses: z.number().default(10),
    maxDiskWriteMB: z.number().default(1024),
    vault: z.object({
        enabled: z.boolean().default(false),
        path: z.string().optional(),
    }).default({}),
    auditLog: z.object({
        enabled: z.boolean().default(true),
        path: z.string().optional(),
        retentionDays: z.number().default(90),
    }).default({}),
    /** v5.0: PII redaction before sending context to LLM providers */
    redactPII: z.boolean().default(false),
    /** v5.0: Secret exfiltration scanning level */
    secretScan: z.object({
        level: z.enum(['tool_only', 'full']).default('tool_only'),
    }).default({}),
    /** v5.0: Pre-execution command scanner for dangerous patterns */
    preExecScan: z.enum(['off', 'warn', 'block']).default('warn'),
    preExecScanAllow: z.array(z.string()).default([]),
});

export const GatewayConfigSchema = z.object({
    host: z.string().default(DEFAULT_GATEWAY_HOST),
    port: z.number().default(DEFAULT_GATEWAY_PORT),
    webPort: z.number().default(DEFAULT_WEB_PORT),
    auth: z.object({
        mode: z.enum(['none', 'token', 'password']).default('token'),
        token: z.string().optional(),
        password: z.string().optional(),
    }).default({}),
    /**
     * Hunt Finding #27 (2026-04-14): max parallel /api/message requests the
     * gateway will accept before returning HTTP 503. Hardcoded to 5 before
     * this was added. Tune higher for production deployments where the
     * upstream model provider can handle more concurrent requests.
     * Valid range: 1-1000. Default: 5 (safe for local Ollama).
     */
    maxConcurrentMessages: z.number().int().min(1).max(1000).default(5),
    /**
     * Hunt Finding #29 (2026-04-14): global fetch() HTTP pool configuration.
     * Without this, Node's default dispatcher has no per-origin connection
     * cap and the keep-alive pool to Ollama grew to 80+ sockets under load.
     * The defaults are tuned for a single-machine Ollama deployment.
     */
    httpPool: z.object({
        /** Max connections per origin (in-flight + idle). Default 16. */
        connections: z.number().int().min(1).max(1024).default(16),
        /** Idle keep-alive timeout in ms. Default 10_000. */
        keepAliveTimeoutMs: z.number().int().min(1_000).max(300_000).default(10_000),
        /** Hard cap on keep-alive bumps in ms. Default 60_000. */
        keepAliveMaxTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
        /** Max time to wait for response headers. Default 60_000. */
        headersTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
        /** Max time to wait for full response body. Default 300_000. */
        bodyTimeoutMs: z.number().int().min(1_000).max(1_200_000).default(300_000),
    }).default({}),
});

export const AgentConfigSchema = z.object({
    model: z.string().default(DEFAULT_MODEL),
    maxTokens: z.number().default(DEFAULT_MAX_TOKENS),
    temperature: z.number().min(0).max(2).default(DEFAULT_TEMPERATURE),
    systemPrompt: z.string().optional(),
    /** Active persona ID (filename stem from assets/personas/). Default 'default' = no persona override. */
    persona: z.string().default('default'),
    workspace: z.string().optional(),
    sessionCompaction: z.object({
        enabled: z.boolean().default(true).describe('Auto-rotate sessions when limits exceeded'),
        maxSessionRuns: z.number().default(200).describe('Max interactions per session before rotation'),
        maxInputTokens: z.number().default(2000000).describe('Max input tokens per session'),
        maxSessionAgeHours: z.number().default(72).describe('Max session age in hours'),
    }).default({}).describe('Session compaction thresholds (Paperclip pattern)'),
    /** Max tool-calling rounds per message in autonomous mode */
    maxRounds: z.number().default(25),
    /** Hard cap on tool rounds (safety limit) */
    maxToolRoundsHard: z.number().default(50),
    /** Enable dynamic budget (auto-calculates rounds based on task complexity) */
    dynamicBudget: z.boolean().default(true),
    /** Force tool_choice=required in autonomous mode */
    forceToolUse: z.boolean().default(true),
    thinkingMode: z.enum(['off', 'low', 'medium', 'high']).default('medium'),
    /** Model aliases â e.g. { fast: "openai/gpt-4o-mini", smart: "anthropic/claude-sonnet-4-20250514", local: "ollama/qwen3.5:4b" } */
    // Hunt Finding #42 (2026-04-15): README promises built-in aliases
    // `fast, smart, cheap, reasoning, local`. Zod's .default() replaces the
    // whole record on any user override, so once a user customized aliases
    // their file would LOSE the built-ins. Use .transform() to merge user
    // overrides on top of the built-ins.
    modelAliases: z.record(z.string(), z.string())
        .default({
            fast: 'ollama/qwen3.5:cloud',
            smart: 'ollama/glm-5:cloud',
            reasoning: 'ollama/kimi-k2.6:cloud',
            cheap: 'ollama/qwen3.5:cloud',
            local: 'ollama/qwen3.5:4b',
            cloud: 'ollama/kimi-k2.6:cloud',
        })
        .transform((userAliases): Record<string, string> => ({
            // Ollama cloud-first built-ins (always present as a floor)
            fast: 'ollama/qwen3.5:cloud',
            smart: 'ollama/glm-5:cloud',
            cheap: 'ollama/qwen3.5:cloud',
            reasoning: 'ollama/kimi-k2.6:cloud',
            local: 'ollama/qwen3.5:4b',
            cloud: 'ollama/kimi-k2.6:cloud',
            // User overrides win
            ...userAliases,
        })),
    costOptimization: z.object({
        smartRouting: z.boolean().default(true),
        contextSummarization: z.boolean().default(true),
        dailyBudgetUsd: z.number().optional(),
        /**
         * v4.13 ancestor-extraction (Hermes smart_model_routing): dedicated
         * model for ultra-simple turns ("hi", "what time is it?", "who made
         * you?"). When set, TITAN's simple-turn detector routes these
         * messages here regardless of tier analysis. Leave empty to disable.
         * Example: "ollama/minimax-m2.7:cloud" (fast + coherent on Titan PC).
         */
        simpleTurnModel: z.string().optional(),
    }).optional(),
    /** Restrict which models users can select via /model. Empty = all allowed. Supports wildcards: "openai/*" */
    allowedModels: z.array(z.string()).default([]),
    /** Ordered fallback chain of model IDs to try when the primary model fails (e.g. rate limit, timeout, 5xx) */
    fallbackChain: z.array(z.string()).default([]),
    /** Maximum retries across the fallback chain before giving up */
    fallbackMaxRetries: z.number().default(3),
    /** Enable periodic reflection during agent loop (LLM self-assessment) */
    reflectionEnabled: z.boolean().default(true),
    /** Reflect every N rounds (default: 3) */
    reflectionInterval: z.number().default(3),
    /** Enable automatic model switching when tool calling fails (self-healing) */
    selfHealEnabled: z.boolean().default(true),
    /** Number of consecutive tool call failures before auto-switching models (2-10) */
    selfHealThreshold: z.number().min(2).max(10).default(3),
    /** Models known to reliably support tool calling â used as self-heal fallbacks */
    toolCapableModels: z.array(z.string()).default([]),
    /** Allow registered agents to propose new goals during the nightly dreaming cycle.
     *  Proposals become pending approvals that a human (or approver agent) must accept
     *  before the goal is created. Opt-in because it starts the LLM on a schedule. */
    autoProposeGoals: z.boolean().default(false),
    /** Maximum goal proposals a single agent can file per rolling 24h window. */
    proposalRateLimitPerDay: z.number().min(0).max(20).default(3),
    /** Model alias used for the proposal generation step. Should be cheap/fast. */
    proposalModel: z.string().default('fast'),
    /** v5.0: Prompt budget ratios — cap tokens for each context section (Space Agent parity) */
    promptBudget: z.object({
        systemRatio: z.number().min(0).max(1).default(0.3),
        historyRatio: z.number().min(0).max(1).default(0.5),
        transientRatio: z.number().min(0).max(1).default(0.2),
        maxTokens: z.number().default(12000),
    }).optional(),
});

export const MeshConfigSchema = z.object({
    enabled: z.boolean().default(false),
    secret: z.string().optional(),
    /** Auto-discover peers via mDNS (Bonjour) on the local network */
    mdns: z.boolean().default(true),
    /** Auto-discover peers via Tailscale VPN */
    tailscale: z.boolean().default(true),
    /** Manually specified peer addresses (host:port) */
    staticPeers: z.array(z.string()).default([]),
    /** Allow remote nodes to use this node's models */
    allowRemoteModels: z.boolean().default(true),
    /** Maximum concurrent remote tasks */
    maxRemoteTasks: z.number().default(3),
    /** Maximum number of connected peers */
    maxPeers: z.number().default(5),
    /** Auto-approve discovered peers (skip approval prompt) */
    autoApprove: z.boolean().default(false),
    /** Timeout for mesh task RPC in milliseconds */
    taskTimeoutMs: z.number().default(120_000),
    /** Heartbeat interval in milliseconds */
    heartbeatIntervalMs: z.number().default(60_000),
    /** Time before a peer is considered stale and pruned (ms, default 5 min) */
    peerStaleTimeoutMs: z.number().default(300_000),
});

export const TunnelConfigSchema = z.object({
    /** Enable Cloudflare Tunnel */
    enabled: z.boolean().default(false),
    /** Tunnel mode: 'quick' (free trycloudflare.com URL) or 'named' (custom domain) */
    mode: z.enum(['quick', 'named']).default('quick'),
    /** Tunnel ID for named tunnels */
    tunnelId: z.string().optional(),
    /** Cloudflare tunnel token (for named tunnels) */
    token: z.string().optional(),
    /** Custom hostname for named tunnels */
    hostname: z.string().optional(),
});

export const ToolSearchConfigSchema = z.object({
    /** Enable compact tool mode with tool_search discovery (saves 60-80% input tokens) */
    enabled: z.boolean().default(true),
    /** Core tools always sent to the LLM without needing search.
     *  When empty (default), uses DEFAULT_CORE_TOOLS from toolSearch.ts.
     *  Override only if you need a specific custom list. */
    coreTools: z.array(z.string()).default([]),
});

export const SandboxConfigSchema = z.object({
    /** Enable sandbox code execution (requires Docker or OpenShell) */
    enabled: z.boolean().default(true),
    /** Sandbox engine: docker (default) or openshell (NVIDIA) */
    engine: z.enum(['docker', 'openshell']).default('docker'),
    /** Docker image name for the sandbox container */
    image: z.string().default('titan-sandbox'),
    /** Default execution timeout in milliseconds */
    timeoutMs: z.number().default(60000),
    /** Container memory limit in MB */
    memoryMB: z.number().default(512),
    /** Container CPU limit */
    cpus: z.number().default(1),
    /** Tools denied inside sandbox (prevent escape) */
    deniedTools: z.array(z.string()).default([
        'shell', 'exec', 'code_exec', 'process', 'apply_patch',
    ]),
});

export const BrainConfigSchema = z.object({
    /** Enable embedded small LLM for intelligent routing (tool selection, classification) */
    enabled: z.boolean().default(false),
    /** Which small model to use (e.g. 'smollm2-360m', 'qwen3.5-0.8b', or custom fine-tuned model name) */
    model: z.string().default('smollm2-360m'),
    /** Auto-download model on first enable */
    autoDownload: z.boolean().default(true),
    /** Maximum tools to select per request */
    maxToolsPerRequest: z.number().default(12),
    /** Inference timeout in milliseconds */
    timeoutMs: z.number().default(2000),
});

export const DeliberationConfigSchema = z.object({
    /** Enable deliberative reasoning for complex requests */
    enabled: z.boolean().default(true),
    /** Auto-detect ambitious requests that need deliberation (default: false â use /plan explicitly) */
    autoDetect: z.boolean().default(false),
    /** Model override for reasoning phase (falls back to agent.modelAliases.reasoning) */
    reasoningModel: z.string().optional(),
    /** Require user approval before executing a plan */
    approvalRequired: z.boolean().default(true),
    /** Maximum number of steps in a generated plan */
    maxPlanSteps: z.number().default(10),
});

export const VoiceConfigSchema = z.object({
    /** Enable voice chat (requires LiveKit server + voice agent running) */
    enabled: z.boolean().default(false),
    /** LiveKit server WebSocket URL */
    livekitUrl: z.string().default('ws://localhost:7880'),
    /** LiveKit API key (matches livekit server config) */
    livekitApiKey: z.string().default('devkey'),
    /** LiveKit API secret (matches livekit server config) */
    livekitApiSecret: z.string().default('secret'),
    /** URL of the voice agent (for health checks) */
    agentUrl: z.string().default('http://localhost:8081'),
    /** Default TTS voice name */
    ttsVoice: z.string().default('andrew'),
    /** TTS engine: f5-tts only */
    ttsEngine: z.enum(['f5-tts']).default('f5-tts'),
    /** TTS server URL (F5-TTS: 5006) */
    ttsUrl: z.string().default('http://localhost:5006'),
    /** STT engine: faster-whisper | nemotron-asr | openai */
    sttEngine: z.enum(['faster-whisper', 'nemotron-asr', 'openai']).default('faster-whisper'),
    /** STT server URL (e.g. faster-whisper) */
    sttUrl: z.string().default('http://localhost:48421'),
    /** Voice performance: max tool rounds before forcing response */
    maxToolRounds: z.number().default(3),
    /** Voice performance: enable fast-path (skip deliberation, Brain, reflection) */
    fastPath: z.boolean().default(true),
    /** Override model for voice chat (faster model for low-latency responses). Falls back to agent.model if unset. */
    model: z.string().optional(),
    /** Silence timeout in milliseconds — how long to wait after speech ends before auto-sending transcript */
    silenceTimeoutMs: z.number().default(3000),
});

export const ContextEnginePluginConfigSchema = z.object({
    name: z.string(),
    enabled: z.boolean().default(true),
    options: z.record(z.string(), z.unknown()).default({}),
});

export const PluginsConfigSchema = z.object({
    contextEngine: z.array(ContextEnginePluginConfigSchema).default([]),
});

export const TeachingConfigSchema = z.object({
    /** Enable adaptive teaching system */
    enabled: z.boolean().default(true),
    /** Tool uses before suggesting related tools */
    revealThreshold: z.number().default(5),
    /** Show contextual hints in dashboard and responses */
    showHints: z.boolean().default(true),
    /** Show first-run wizard for new users */
    firstRunWizard: z.boolean().default(true),
});

export const OAuthConfigSchema = z.object({
    google: z.object({
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        scopes: z.array(z.string()).default([
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/documents',
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/tasks',
            'https://www.googleapis.com/auth/contacts.readonly',
            'https://www.googleapis.com/auth/youtube.readonly',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
        ]),
    }).default({}),
});

export const TeamConfigSchema = z.object({
    /** Enable team mode with RBAC */
    enabled: z.boolean().default(false),
    /** Default role for new members added via invite */
    defaultRole: z.enum(['admin', 'operator', 'viewer']).default('operator'),
    /** Require invite code to join (vs. direct add by admin) */
    requireInvite: z.boolean().default(true),
    /** Invite code expiry in hours */
    inviteExpiryHours: z.number().default(48),
    /** Maximum teams a single instance can host */
    maxTeams: z.number().default(10),
    /** Maximum members per team */
    maxMembersPerTeam: z.number().default(50),
});

export const ResearchPipelineConfigSchema = z.object({
    /** Enable multi-agent research pipeline */
    enabled: z.boolean().default(true),
    /** Maximum parallel researcher sub-agents */
    maxParallelAgents: z.number().default(3),
    /** Maximum rounds per researcher sub-agent */
    maxRoundsPerAgent: z.number().default(10),
    /** Maximum total sources across all sub-agents */
    maxSources: z.number().default(30),
    /** Compress intermediate results before synthesis */
    compressIntermediateResults: z.boolean().default(true),
    /** Default output format */
    defaultOutputFormat: z.enum(['report', 'brief', 'raw']).default('report'),
});

export const AutoresearchConfigSchema = z.object({
    /** Enable autonomous experimentation engine */
    enabled: z.boolean().default(true),
    /** Default max experiments per loop */
    maxExperiments: z.number().default(20),
    /** Default time budget in minutes */
    timeBudgetMinutes: z.number().default(30),
    /** Timeout per individual experiment in seconds */
    experimentTimeoutSeconds: z.number().default(300),
    /** Use git branches for experiment isolation */
    gitBranching: z.boolean().default(true),
    /** Directory for experiment results */
    resultsDir: z.string().default('~/.titan/experiments'),
});

/** Eval / auto-corpus configuration (Phase 7) */
export const EvalConfigSchema = z.object({
    /** Enable automatic recording of failed eval traces as auto-tapes */
    enabled: z.boolean().default(true),
    /** Retention period for auto-corpus tapes in days (0 = never purge) */
    autoCorpus: z.object({
        retentionDays: z.number().min(0).default(30),
    }).default({}),
});

export const CapsolverConfigSchema = z.object({
    /** Enable CapSolver CAPTCHA solving */
    enabled: z.boolean().default(false),
    /** CapSolver API key */
    apiKey: z.string().optional(),
    /** Timeout for solving in milliseconds */
    timeoutMs: z.number().default(120_000),
    /** Preferred reCAPTCHA v3 minimum score (0.1â0.9) */
    minScore: z.number().min(0.1).max(0.9).default(0.7),
});

/** Soma organism layer — homeostatic drives, hormonal broadcasts, shadow
 *  rehearsal.
 *
 *  v5.0 "Spacewalk" flips `enabled` to true by default. Tony's ask
 *  ("SOMA should be enabled by a flip of a switch") — new installs get
 *  Soma on out of the box with the SettingsWizard surfacing the toggle,
 *  and the Soma widget ships with a one-click master switch so anyone
 *  can flip it off at any time. Existing users keep whatever value is
 *  already in their titan.json; only brand-new installs without the
 *  field defaulted to false historically. */
export const OrganismConfigSchema = z.object({
    enabled: z.boolean().default(true).describe('Master switch. When true (default for v5.0+), Soma registers driveTick, writes drive state, and injects the hormonal ambient-state block into the system prompt. Flip via titan.json, Soma widget header, or Settings.'),
    hormonesInPrompt: z.boolean().default(true).describe('Include hormonal ambient-state block in the system prompt when Soma is enabled.'),
    pressureThreshold: z.number().min(0).max(5).default(1.2).describe('Combined drive pressure above which Soma fires a proposal. Raise to make Soma more conservative.'),
    driveSetpoints: z.record(z.string(), z.number().min(0).max(1)).optional().describe('Per-drive setpoint overrides: { purpose: 0.7, hunger: 0.6, ... }'),
    driveWeights: z.record(z.string(), z.number().min(0.1).max(3.0)).optional().describe('Per-drive weight overrides for pressure fusion. 1.0 is baseline; higher = more urgent.'),
    disabledDrives: z.array(z.string()).default([]).describe('Drive IDs to skip entirely in computeAllDrives + pressure fusion.'),
    shadowEnabled: z.boolean().default(true).describe('Run shadow rehearsal before each Soma proposal is filed for approval.'),
    shadowModel: z.string().default('fast').describe('Model alias (or provider/model id) used for shadow rehearsal.'),
    tickIntervalMs: z.number().min(10_000).max(3_600_000).default(60_000).describe('Drive tick cadence in ms. Default 60s; minimum 10s to prevent self-DoS.'),
});

/**
 * Self-Modification pipeline (v4.8.0+) — captures autonomous write_file
 * outputs from Soma-driven goals, reviews them through the specialist
 * panel, and opens GitHub PRs for human merge. OFF by default so
 * existing users are unaffected. Tony flips `enabled: true` explicitly.
 */
/**
 * Homelab (v4.8.4+) — list of machines the Homelab panel should poll
 * for health. Defaults to Tony's 3-machine setup when omitted.
 */
export const HomelabMachineSchema = z.object({
    name: z.string(),
    ip: z.string(),
    role: z.string().default(''),
    port: z.number().int().min(1).max(65535).default(48420),
    protocol: z.enum(['http', 'https']).default('https'),
    path: z.string().default('/api/health'),
});
export const HomelabConfigSchema = z.object({
    machines: z.array(HomelabMachineSchema).optional().describe('Machines listed on the Homelab panel. If omitted, a sensible default homelab set is used.'),
});

export const SelfModConfigSchema = z.object({
    enabled: z.boolean().default(false).describe('Master switch. When false, no autonomous writes are captured and no PRs are opened.'),
    autoReview: z.boolean().default(true).describe('When a proposal is captured, automatically queue the specialist panel. Disable for manual-only review.'),
    autoPR: z.boolean().default(false).describe('When specialists all approve, automatically open the PR. When false, Tony must click "Create PR" in the UI.'),
    maxPRsPerDrivePer48h: z.number().min(1).max(20).default(1).describe('Rate limit — how many self-proposal PRs a single drive can generate in a rolling 48h window.'),
    pollIntervalMs: z.number().min(60_000).max(3_600_000).default(300_000).describe('How often to poll GitHub for merge/close status on open PRs. 5 min default.'),
});

export const TitanConfigSchema = z.object({
    /** Whether the user has completed the web onboarding wizard */
    onboarded: z.boolean().default(false),
    agent: AgentConfigSchema.default({}),
    /**
     * Per-specialist model overrides. Keys are specialist ids
     * (scout/builder/writer/analyst/sage). Values override the hardcoded
     * default model from specialists.ts. Editable via the UI so the user
     * can swap specialist models without a code change (e.g. point Sage
     * at a local model when Claude Code is unavailable).
     */
    specialists: z.object({
        overrides: z.record(z.string(), z.object({
            model: z.string().optional(),
        })).default({}),
    }).default({}),
    organism: OrganismConfigSchema.default({}),
    selfMod: SelfModConfigSchema.default({}),
    homelab: HomelabConfigSchema.default({}),
    providers: z.object({
        /** v5.4.1: Per-model output-token caps override. Keys are provider/model IDs.
         *  Values override the built-in static table + family heuristics. */
        modelCapabilities: z.record(z.string(), z.object({
            contextWindow: z.number(),
            maxOutput: z.number(),
            supportsThinking: z.boolean().optional(),
        })).optional(),
        anthropic: ProviderConfigSchema.default({}),
        openai: ProviderConfigSchema.default({}),
        google: ProviderConfigSchema.default({}),
        ollama: ProviderConfigSchema.default({}),
        // OpenAI-compatible providers
        groq: ProviderConfigSchema.default({}),
        mistral: ProviderConfigSchema.default({}),
        openrouter: ProviderConfigSchema.default({}),
        fireworks: ProviderConfigSchema.default({}),
        xai: ProviderConfigSchema.default({}),
        together: ProviderConfigSchema.default({}),
        deepseek: ProviderConfigSchema.default({}),
        cerebras: ProviderConfigSchema.default({}),
        cohere: ProviderConfigSchema.default({}),
        perplexity: ProviderConfigSchema.default({}),
        venice: ProviderConfigSchema.default({}),
        bedrock: ProviderConfigSchema.default({}),
        litellm: ProviderConfigSchema.default({}),
        azure: ProviderConfigSchema.default({}),
        deepinfra: ProviderConfigSchema.default({}),
        sambanova: ProviderConfigSchema.default({}),
        kimi: ProviderConfigSchema.default({}),
        huggingface: ProviderConfigSchema.default({}),
        ai21: ProviderConfigSchema.default({}),
        'cohere-v2': ProviderConfigSchema.default({}),
        reka: ProviderConfigSchema.default({}),
        zhipu: ProviderConfigSchema.default({}),
        yi: ProviderConfigSchema.default({}),
        inflection: ProviderConfigSchema.default({}),
        novita: ProviderConfigSchema.default({}),
        replicate: ProviderConfigSchema.default({}),
        lepton: ProviderConfigSchema.default({}),
        anyscale: ProviderConfigSchema.default({}),
        octo: ProviderConfigSchema.default({}),
        nous: ProviderConfigSchema.default({}),
        nvidia: ProviderConfigSchema.default({}),
        minimax: ProviderConfigSchema.default({}),
    }).default({}),
    channels: z.object({
        discord: ChannelConfigSchema.default({}),
        telegram: ChannelConfigSchema.default({}),
        slack: ChannelConfigSchema.default({}),
        whatsapp: ChannelConfigSchema.default({}),
        webchat: ChannelConfigSchema.default({}),
        googlechat: ChannelConfigSchema.default({}),
        matrix: ChannelConfigSchema.default({}),
        signal: ChannelConfigSchema.default({}),
        msteams: ChannelConfigSchema.default({}),
        bluebubbles: ChannelConfigSchema.default({}),
        irc: ChannelConfigSchema.default({}),
        mattermost: ChannelConfigSchema.default({}),
        lark: ChannelConfigSchema.default({}),
        email_inbound: ChannelConfigSchema.default({}),
        line: ChannelConfigSchema.default({}),
        zulip: ChannelConfigSchema.default({}),
        // v4.3.2: messenger defaults to enabled=true so env-var-configured
        // Page tokens keep working without requiring a JSON toggle. Channel
        // still self-disables at runtime when FB_PAGE_ACCESS_TOKEN is unset.
        messenger: MessengerChannelConfigSchema.default({
            enabled: true,
            allowFrom: [],
            dmPolicy: 'pairing',
            voiceReplies: { enabled: true, voice: 'andrew', maxChars: 1000 },
        }),
        // v4.4.0: Twilio voice — real phone calls. Tony dials the Twilio
        // number, talks, hears F5-TTS Andrew reply. Extends the base channel
        // schema so other code that iterates channels (doctor, selfHeal,
        // sandbox) sees the shared fields (enabled/token/apiKey/dmPolicy).
        twilio: ChannelConfigSchema.extend({
            accountSid: z.string().optional(),
            authToken: z.string().optional(),
            phoneNumber: z.string().optional(),
            voice: z.string().default('andrew'),
            /** E.164 numbers allowed to reach the agent. Everyone else gets
             *  a polite "wrong number" and hangup. */
            allowedCallers: z.array(z.string()).default([]),
            /** Public HTTPS hostname for audio playback URLs sent to
             *  Twilio. Should be a Tailscale Funnel or equivalent. */
            publicHost: z.string().default(''),
        }).default({
            enabled: true,
            allowFrom: [],
            dmPolicy: 'pairing',
            voice: 'andrew',
            allowedCallers: [],
            publicHost: '',
        }),
    }).default({}),
    gateway: GatewayConfigSchema.default({}),
    security: SecurityConfigSchema.default({}),
    memory: z.object({
        enabled: z.boolean().default(true),
        maxHistoryMessages: z.number().default(50),
        /**
         * Enable semantic vector search via Ollama embeddings (Tier 2 memory).
         *
         * v5.4.0: default is now `true`. The vector layer (`src/memory/vectors.ts`,
         * 566 LOC) was production-ready but unreachable behind a default-off
         * switch — retrieval was purely literal substring matching, so any
         * paraphrased recall failed. Flipping the default activates the
         * existing infrastructure.
         *
         * Fallback contract: if the embedding model isn't available on
         * Ollama (or the request errors), `addVector` and the vector-side
         * of `searchMemory` silently fall back to keyword-only search.
         * That fallback is best-effort and logged at debug level — see
         * `isVectorSearchAvailable()` in `vectors.ts`.
         *
         * To opt out, set `memory.vectorSearchEnabled = false` in titan.json.
         */
        vectorSearchEnabled: z.boolean().default(true),
        /** Embedding model for vector search (must be available on Ollama) */
        embeddingModel: z.string().default('nomic-embed-text'),
        /** v5.0: Pluggable memory provider ('builtin' = default three-tier memory) */
        provider: z.string().default('builtin'),
        /** v5.0: Provider-specific configuration passed to the memory backend */
        providerConfig: z.record(z.string(), z.unknown()).default({}),
    }).default({}),
    skills: z.object({
        enabled: z.boolean().default(true),
        autoDiscover: z.boolean().default(true),
        marketplace: z.boolean().default(false),
    }).default({}),
    mesh: MeshConfigSchema.default({}),
    fileManager: z.object({
        /** Root directories the file manager can browse. Supports ~ for home. */
        roots: z.array(z.string()).default(['~/.titan']),
        /** Patterns to block from browsing/editing (security) */
        blockedPatterns: z.array(z.string()).default(['.ssh', '.env', '.aws', '.gnupg', 'node_modules', '.git/objects']),
    }).default({}),
    logging: z.object({
        level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
        file: z.boolean().default(true),
    }).default({}),
    autopilot: z.object({
        /** Enable autopilot scheduled runs */
        enabled: z.boolean().default(false),
        /** Run autopilot in simulation mode (no tool execution) */
        dryRun: z.boolean().default(false),
        /** Cron expression for scheduled runs (default: nightly 2am) */
        schedule: z.string().default('0 2 * * *'),
        /** Model override for autopilot runs (cheaper model for routine tasks) */
        model: z.string().default('anthropic/claude-haiku'),
        /** Path to checklist file (default: ~/.titan/AUTOPILOT.md) */
        checklistPath: z.string().optional(),
        /** Maximum tokens per autopilot run */
        maxTokensPerRun: z.number().default(4000),
        /** Maximum tool rounds per run */
        maxToolRounds: z.number().default(5),
        /** Where to deliver notable/urgent results */
        reportChannel: z.string().default('cli'),
        /** Run history retention count */
        maxRunHistory: z.number().default(30),
        /** Skip run if checklist is empty */
        skipIfEmpty: z.boolean().default(true),
        /** Active hours (only run during these hours, 24h format) */
        activeHours: z.object({
            start: z.number().min(0).max(23).default(0),
            end: z.number().min(0).max(23).default(23),
        }).optional(),
        /** Autopilot mode: 'checklist' (AUTOPILOT.md), 'goals' (goal-based), or 'self-improve' (autonomous self-improvement) */
        mode: z.enum(['checklist', 'goals', 'self-improve']).default('checklist'),
        /** Goal-based autopilot settings */
        goals: z.object({
            /** Maximum active goals */
            maxActiveGoals: z.number().default(5),
            /** Maximum subtasks per goal */
            maxSubtasksPerGoal: z.number().default(20),
            /** Budget per goal in USD */
            budgetPerGoal: z.number().default(1.00),
            /** Allow TITAN to self-initiate tasks from the goal queue */
            selfInitiate: z.boolean().default(false),
        }).default({}),
    }).default({}),
    sandbox: SandboxConfigSchema.default({}),
    toolSearch: ToolSearchConfigSchema.default({}),
    brain: BrainConfigSchema.default({}),
    tunnel: TunnelConfigSchema.default({}),
    deliberation: DeliberationConfigSchema.default({}),
    voice: VoiceConfigSchema.default({}),
    oauth: OAuthConfigSchema.default({}),
    plugins: PluginsConfigSchema.default({}),
    teaching: TeachingConfigSchema.default({}),
    autonomy: z.object({
        /** autonomous = full auto, supervised = asks for dangerous ops, locked = asks for everything */
        mode: z.enum(['autonomous', 'supervised', 'locked']).default('supervised'),
        /** Auto-approve moderate-risk tools in main session (cli/webchat) */
        autoApproveMainSession: z.boolean().default(true),
        /** Timeout for HITL approval requests (ms). Auto-deny after timeout. */
        approvalTimeoutMs: z.number().default(60000),
        /** Notify user of auto-approved actions */
        notifyOnAutoApprove: z.boolean().default(true),
        /** Override MAX_TOOL_ROUNDS in autonomous mode */
        maxToolRoundsOverride: z.number().default(25),
        /** Override circuit breaker threshold in autonomous mode */
        circuitBreakerOverride: z.number().default(50),
        /** Auto-trigger deliberation without approval in autonomous mode */
        autoDeliberate: z.boolean().default(true),
        /** Minimum interval between initiative actions (ms) */
        initiativeIntervalMs: z.number().default(60000),
        /** Enable event-driven proactive initiative (follow-ups, monitoring) */
        proactiveInitiative: z.boolean().default(false),
        /**
         * v4.9.0-local.8: self-modification scope & staging.
         *
         * When a goal has a tag that matches `tags`, any file-mutating
         * tool call (write_file, edit_file, append_file, apply_patch)
         * MUST target a path inside `target`. Writes to any other path
         * are rejected by the toolRunner scope-lock. This stops the
         * "TITAN hallucinates self-modifying its own framework but
         * actually writes to /home/dj/titan-saas or /home/titan/"
         * pattern observed 2026-04-18.
         *
         * When `staging` is enabled, writes to `target` are redirected
         * to a per-goal staging directory and surface as `self_mod_pr`
         * approvals — the human applies or rejects the diff.
         */
        selfMod: z.object({
            /**
             * Absolute path where self-modification is allowed to land.
             * Defaults to the TITAN deployment root on Titan PC.
             */
            target: z.string().default('/opt/TITAN'),
            /**
             * Goal tags that activate scope-lock. If the active session's
             * goal has ANY of these tags, writes are scope-locked to `target`.
             */
            tags: z.array(z.string()).default([
                'self-healing', 'self-repair', 'self-mod', 'self-modification',
                'core-framework', 'framework', 'architecture',
                'core', 'autonomy',
            ]),
            /**
             * When true, writes to `target` go through a human-approval PR
             * gate (staged → approved → applied). When false, writes land
             * directly (scope-lock still enforces target prefix).
             */
            staging: z.boolean().default(true),
            /**
             * Directory for staged self-mod bundles. Each approved goal
             * gets its own subdir. Relative paths resolve under TITAN_HOME.
             */
            stagingDir: z.string().default('self-mod-staging'),
            /**
             * v4.10.0-local polish: Opus review gate. Before an approved
             * self_mod_pr's files land in `target`, send the bundle to
             * a strong reviewer model (Claude Opus via OpenRouter by
             * default) for one final correctness + integration check.
             * Local LLMs write the code; Opus reviews it.
             */
            reviewer: z.object({
                enabled: z.boolean().default(true),
                /**
                 * Default: Claude Code CLI with Sonnet 4.5. Routes through
                 * the `claude` CLI subprocess which uses Tony's MAX plan
                 * OAuth — so effectively free for this use case (MAX is
                 * ~$100/month flat with generous caps, not metered).
                 *
                 * DIFFERENT FAMILY than Builder (Qwen) = no correlated bugs.
                 * Claude family is historically strongest at CRITIQUE.
                 *
                 * Setup (one-time on TITAN host):
                 *   npm install -g @anthropic-ai/claude-code
                 *   claude login   (signs in w/ MAX account; OAuth in ~/.claude/)
                 *
                 * Fallback alternatives:
                 *   'openrouter/qwen/qwen3.6-plus'          (free on OpenRouter but same family as Builder)
                 *   'openrouter/anthropic/claude-sonnet-4.6' (paid, ~$0.02/review)
                 *   'openrouter/anthropic/claude-opus-4.6'   (paid, ~$0.15/review)
                 *
                 * If `claude` CLI isn't installed on TITAN host, reviewer
                 * returns 'skipped' and the apply proceeds (fail-open).
                 */
                model: z.string().default('claude-code/sonnet-4.5'),
                maxDiffChars: z.number().default(50_000),
                blockOnReject: z.boolean().default(true),
                /** v4.10.0-local polish: cost caps. Qwen3.6-plus is free so these
                 *  rarely bite; but if reviewer model is ever switched to a paid
                 *  one, these prevent runaway bills. Current: $9.54 OpenRouter budget. */
                maxPerReviewUsd: z.number().default(0.25),
                maxDailyUsd: z.number().default(1.50),
                maxMonthlyUsd: z.number().default(5.00),
            }).default({}),
        }).default({}),
    }).default({}),
    subAgents: z.object({
        /** Enable sub-agent spawning */
        enabled: z.boolean().default(true),
        /** Maximum concurrent sub-agents */
        maxConcurrent: z.number().default(3),
        /** Maximum tool rounds per sub-agent */
        maxRoundsPerAgent: z.number().default(10),
        /** Default model for sub-agents */
        defaultModel: z.string().default('fast'),
        /** Auto-delegate complex tasks to sub-agents */
        enableWorktrees: z.boolean().default(false).describe('Create git worktrees for coder sub-agents'),
    autoDelegate: z.boolean().default(true),
        /** Maximum nesting depth for sub-agents (1 = no sub-sub-agents, 2 = one level of nesting) */
        maxDepth: z.number().default(2),
    }).default({}),
    teams: TeamConfigSchema.default({}),
    researchPipeline: ResearchPipelineConfigSchema.default({}),
    autoresearch: AutoresearchConfigSchema.default({}),
    eval: EvalConfigSchema.default({}),
    homeAssistant: z.object({
        /** Home Assistant instance URL (e.g., http://homeassistant.local:8123) */
        url: z.string().default(''),
        /** Long-lived access token for Home Assistant API */
        token: z.string().default(''),
    }).default({}),
    mcp: z.object({
        /** MCP server mode â expose TITAN's tools to other agents */
        server: z.object({
            /** Enable MCP server (HTTP transport on gateway port) */
            enabled: z.boolean().default(false),
        }).default({}),
    }).default({}),
    selfImprove: z.object({
        /** Enable autonomous self-improvement */
        enabled: z.boolean().default(true),
        /** How many self-improvement runs per day (1-12) */
        runsPerDay: z.number().min(1).max(12).default(1),
        /** Cron expressions for scheduled runs */
        schedule: z.array(z.string()).default(['0 2 * * *']),
        /** Time budget per run in minutes (5-120) */
        budgetMinutes: z.number().min(5).max(120).default(30),
        /** Which improvement areas to target */
        areas: z.array(z.string()).default(['prompts', 'tool-selection', 'response-quality', 'error-recovery']),
        /** Auto-apply successful experiments without human approval */
        autoApply: z.boolean().default(false),
        /** Maximum total GPU/compute minutes per day (safety cap) */
        maxDailyBudgetMinutes: z.number().default(120),
        /** Skip runs on weekends */
        pauseOnWeekends: z.boolean().default(false),
        /** Send notification on successful improvement */
        notifyOnSuccess: z.boolean().default(true),
        /** Notification channel */
        notifyChannel: z.string().default('cli'),
    }).default({}),
    training: z.object({
        /** Enable local model training/fine-tuning */
        enabled: z.boolean().default(false),
        /** Directory for training data */
        dataDir: z.string().default('~/.titan/training-data'),
        /** Training time budget in minutes */
        budgetMinutes: z.number().default(30),
        /** Training method */
        method: z.enum(['lora', 'qlora', 'full']).default('lora'),
        /** Base model to fine-tune. Empty = use active model (if local/Ollama). */
        baseModel: z.string().default(''),
        /** Auto-deploy trained model to Ollama */
        autoDeploy: z.boolean().default(false),
        autoresearchEnabled: z.boolean().default(false),
        autoresearchSchedule: z.array(z.string()).default(['0 3 * * *']),  // 3am daily
    }).default({}),
    daemon: z.object({
        /** Enable persistent agent daemon (always-on awareness loop) */
        enabled: z.boolean().default(false),
        /** Watcher configurations â pluggable checker functions on intervals */
        watchers: z.array(z.object({
            name: z.string(),
            enabled: z.boolean().default(true),
            intervalMs: z.number().default(300_000), // 5 min
        })).default([]),
        /** Maximum autonomous actions per hour (rate limiting) */
        maxActionsPerHour: z.number().default(10),
    }).default({}),
    capsolver: CapsolverConfigSchema.default({}),
    vram: z.object({
        /** Master switch for VRAM orchestrator */
        enabled: z.boolean().default(true),
        /** GPU vendor override â auto-detects by default. Set to force a specific vendor. */
        gpuVendor: z.enum(['auto', 'nvidia', 'amd', 'apple', 'none']).default('auto'),
        /** GPU polling interval in milliseconds (0 = disabled) */
        pollIntervalMs: z.number().default(10000),
        /** Always keep this much VRAM free as a safety buffer (MB) */
        reserveMB: z.number().default(1024),
        /** Automatically swap to a smaller model when VRAM is needed */
        autoSwapModel: z.boolean().default(true),
        /** Fallback model to load when large model is evicted */
        fallbackModel: z.string().default('qwen3:7b'),
        /** Ollama API URL for model management */
        ollamaUrl: z.string().default('http://localhost:11434'),
        /** GPU service VRAM budgets and priorities */
        services: z.record(z.string(), z.object({
            estimatedMB: z.number(),
            priority: z.number(),
            type: z.enum(['ollama', 'docker', 'process']),
        })).default({
            ollama: { estimatedMB: 0, priority: 1, type: 'ollama' },
            f5_tts: { estimatedMB: 1500, priority: 2, type: 'process' },
            cuopt: { estimatedMB: 5000, priority: 3, type: 'docker' },
            nemotron_asr: { estimatedMB: 4000, priority: 4, type: 'docker' },
        }),
    }).default({}),
    nvidia: z.object({
        /** Master switch â enables all NVIDIA integrations (also triggered by TITAN_NVIDIA=1 env) */
        enabled: z.boolean().default(false),
        /** NVIDIA NIM API key (build.nvidia.com) */
        apiKey: z.string().optional(),
        /** cuOpt GPU-accelerated optimization engine */
        cuopt: z.object({
            enabled: z.boolean().default(false),
            /** cuOpt server URL (REST API endpoint) */
            url: z.string().default('http://localhost:5000'),
        }).default({}),
        /** Nemotron-ASR-Streaming for low-latency speech recognition */
        asr: z.object({
            enabled: z.boolean().default(false),
            /** gRPC endpoint for Nemotron-ASR NIM container */
            grpcUrl: z.string().default('localhost:50051'),
            /** HTTP health endpoint */
            healthUrl: z.string().default('http://localhost:9000'),
        }).default({}),
        /** NVIDIA OpenShell agent sandbox runtime */
        openshell: z.object({
            enabled: z.boolean().default(false),
            /** Path to openshell CLI binary */
            binaryPath: z.string().default('openshell'),
            /** Path to TITAN sandbox policy YAML */
            policyPath: z.string().default(''),
        }).default({}),
    }).default({}),
    x: z.object({
        /** Enable X/Twitter integration */
        enabled: z.boolean().default(false),
        /** Require human review before posting */
        reviewRequired: z.boolean().default(true),
    }).default({}),
    slack: z.object({
        /** Enable Slack skill tools (separate from channel adapter) */
        enabled: z.boolean().default(false),
        /** Slack Bot Token (xoxb-*). Falls back to SLACK_BOT_TOKEN env var */
        botToken: z.string().optional(),
        /** Default channel for posting */
        defaultChannel: z.string().default('general'),
        /** Require human review before posting messages */
        reviewRequired: z.boolean().default(true),
    }).default({}),

    /** Command Post — agent governance layer (Paperclip-inspired) */
    /**
     * v4.13 ancestor-extraction (OpenClaw agent-scope): config-driven agents.
     * Declare a custom agent in titan.json:
     *
     *   "agents": {
     *     "defaults": { "model": "ollama/minimax-m2.7:cloud", "maxRounds": 15 },
     *     "entries": {
     *       "coder-rust": {
     *         "name": "Rust Coder",
     *         "template": "builder",
     *         "model": "ollama/glm-5.1:cloud",
     *         "skillsFilter": ["shell","read_file","write_file","edit_file"],
     *         "tags": ["code","rust"]
     *       }
     *     }
     *   }
     *
     * Built-in specialists (scout/builder/writer/analyst/sage) from
     * src/agent/specialists.ts still work as defaults; config-defined
     * agents layer on top.
     */
    agents: z.object({
        defaults: z.object({
            model: z.string().optional(),
            modelFallbacks: z.array(z.string()).default([]),
            skillsFilter: z.array(z.string()).default([]),
            persona: z.string().optional(),
            maxRounds: z.number().optional(),
            maxTokens: z.number().optional(),
            systemPromptOverride: z.string().optional(),
        }).default({}),
        entries: z.record(z.string(), z.object({
            name: z.string().optional(),
            description: z.string().optional(),
            model: z.string().optional(),
            modelFallbacks: z.array(z.string()).optional(),
            skillsFilter: z.array(z.string()).optional(),
            persona: z.string().optional(),
            systemPromptOverride: z.string().optional(),
            template: z.string().optional(),
            maxRounds: z.number().optional(),
            maxTokens: z.number().optional(),
            workspaceDir: z.string().optional(),
            tags: z.array(z.string()).default([]),
            enabled: z.boolean().default(true),
        })).default({}),
    }).default({}),

    /**
     * Auxiliary model for side tasks — goal-proposal JSON extraction, session
     * title generation, graph entity extraction, structured-spawn reformat,
     * classification, short summaries.
     *
     * Ported from Hermes `agent/auxiliary_client.py` — main agent models
     * (esp. gemma4:31b) are tuned for long reasoning + tool use and often
     * produce empty arrays or prose instead of strict JSON. Routing side
     * tasks to a dedicated fast+cheap model (minimax-m2.7 is proven on
     * Titan PC) makes the autonomous cycle actually produce work.
     *
     * See: src/providers/auxiliary.ts
     */
    auxiliary: z.object({
        /** Explicit model. Wins over preferFamilies. Ex: "ollama/minimax-m2.7:cloud" */
        model: z.string().optional(),
        /** Family-preference order when `model` is unset. Default optimised for Titan PC. */
        preferFamilies: z.array(z.string()).default(['minimax', 'glm', 'qwen', 'nemotron', 'gemma']),
        /** Per-task model overrides. Key = task kind. */
        perTask: z.object({
            json_extraction: z.string().optional(),
            classification: z.string().optional(),
            title: z.string().optional(),
            summary: z.string().optional(),
            reformat: z.string().optional(),
            humanize: z.string().optional(),
        }).default({}),
        /** Kill-switch for auxiliary routing — fall back to main model always. */
        disabled: z.boolean().default(false),
    }).default({}),

    /** v5.0: Lightweight OTEL-compatible diagnostics export */
    diagnostics: z.object({
        otel: z.object({
            enabled: z.boolean().default(false),
            captureContent: z.boolean().default(false),
            endpoint: z.string().optional(),
        }).default({}),
    }).default({}),
    /** v5.0: Shell hooks for lifecycle events */
    hooks: z.object({
        shell: z.object({
            enabled: z.boolean().default(false),
            pre_tool_call: z.array(z.string()).default([]),
            post_tool_call: z.array(z.string()).default([]),
            on_session_start: z.array(z.string()).default([]),
            on_session_end: z.array(z.string()).default([]),
            on_round_start: z.array(z.string()).default([]),
            on_round_end: z.array(z.string()).default([]),
        }).default({}),
    }).default({}),
    /** v5.0: Filesystem checkpoints before destructive operations */
    checkpoints: z.object({
        enabled: z.boolean().default(true),
        maxPerSession: z.number().default(50),
        retentionHours: z.number().default(24),
    }).default({}),
    /** v5.0: Browser automation configuration */
    browser: z.object({
        actionTimeoutMs: z.number().default(60000),
        profiles: z.record(z.string(), z.object({
            headless: z.boolean().optional(),
        })).default({}),
    }).default({}),
    /** v5.0: UI theming */
    ui: z.object({
        theme: z.string().default('dark'),
    }).default({}),
    commandPost: z.object({
        /** Enable the Command Post governance layer */
        enabled: z.boolean().default(false),
        /** Heartbeat monitoring interval in ms */
        heartbeatIntervalMs: z.number().default(60000),
        /** Max concurrent managed agents */
        maxConcurrentAgents: z.number().default(5),
        /** Task checkout auto-expiry in ms (default 30 min) */
        checkoutTimeoutMs: z.number().default(1800000),
        /** Activity feed buffer size */
        activityBufferSize: z.number().default(500),
        /**
         * Gap 4 (plan-this-logical-ocean): path-scoped auto-approval.
         * When enabled, approvals whose (type, payload.kind, payload.path)
         * match an allowlisted rule are short-circuited to status='approved'
         * by the system, instead of landing in the human queue. Off by
         * default — Tony governance preference is opt-in for anything that
         * bypasses his eyes. See src/agent/approvalClassifier.ts for the
         * built-in rule defaults (read-only reads under Desktop/opt/tmp).
         */
        autoApprove: z.object({
            enabled: z.boolean().default(false),
            /** Additional user-defined rules layered on top of the built-in defaults. */
            rules: z.array(z.object({
                /** Approval type this rule matches, or '*' for any type */
                type: z.string().default('*'),
                /** payload.kind this rule matches, or '*' for any */
                kind: z.string().default('*'),
                /** Path prefix payload.path must start with (optional) */
                pathPrefix: z.string().optional(),
                /** 'auto' short-circuits to approved; 'require' forces human approval even if a broader default would auto-approve */
                action: z.enum(['auto', 'require']).default('auto'),
            })).default([]),
        }).default({}),
        /** Auto-purge approvals older than N days (0 = disabled). Default 7 days. */
        approvalRetentionDays: z.number().min(0).default(7),
    }).default({}),

    /**
     * Facebook skill + autopilot config.
     * Added after Hunt Finding #1 (2026-04-14): this key was previously NOT in the
     * schema, so `facebook.autopilotEnabled: false` in titan.json was silently
     * stripped by Zod on load, meaning users could not disable the FB autopilot
     * via config editing. The autopilot would continue to run despite the flag.
     */
    facebook: z.object({
        /** Master switch for FB autopilot (scheduled posts + comment replies). When false, neither runs. */
        autopilotEnabled: z.boolean().default(true),
        /** Disable only comment reply monitoring (kept for finer control). */
        replyMonitorEnabled: z.boolean().default(true),
        /** Model override for autopilot content generation. Empty = use agent.model. */
        model: z.string().default(''),
        /** Max posts per 24h window. v4.0.3: was hardcoded to 6. Keep at 6 for active
         *  hype cadence (one every ~3-4h); Facebook tolerates this well. Going above
         *  ~8/day will trip FB's anti-spam feed throttle and hide today's posts from
         *  the public page view. */
        maxPostsPerDay: z.number().min(1).max(12).default(6),
        /** Minimum hours between consecutive posts. v4.0.3: raised from 2 to 3 after
         *  observing a burst of 4 posts in 40 minutes trigger FB's visibility throttle.
         *  3h * 6 posts = 18h natural spread through the day. */
        minPostGapHours: z.number().min(0.5).max(24).default(3),
    }).default({}),

    /**
     * Alerting — where and how autonomous agent alerts are delivered.
     * Previously accessed via `(config as Record<string, unknown>).alerting` in src/agent/alerts.ts
     * but was NOT in the schema and thus silently stripped on load.
     */
    alerting: z.object({
        /** Minimum severity that triggers alerts: info | warn | error | critical */
        minSeverity: z.enum(['info', 'warn', 'error', 'critical']).default('error'),
        /** Webhook URL for alert delivery (Slack/Discord/etc.) */
        webhookUrl: z.string().optional(),
    }).default({}),

    /**
     * Guardrails — input/output safety filters for the agent loop.
     * Previously accessed via `(config as Record<string, unknown>).guardrails` in src/agent/guardrails.ts
     * but was NOT in the schema and thus silently stripped on load.
     */
    guardrails: z.object({
        /** Master switch for guardrails */
        enabled: z.boolean().default(true),
        /** Log violations only, don't block */
        logOnly: z.boolean().default(false),
    }).default({}),

    /**
     * Telemetry — opt-in local-only event collection for product improvement.
     * Events are stored locally in ~/.titan/telemetry-events.jsonl and never
     * sent to external servers unless explicitly configured.
     */
    telemetry: z.object({
        /**
         * Master switch. Default **false** — no data leaves the user's machine
         * until they explicitly opt in. Must stay false to respect existing
         * installs that never agreed to telemetry.
         */
        enabled: z.boolean().default(false),
        /** Storage mode: local = disk only; remote = POST to remoteUrl when enabled */
        mode: z.enum(['local', 'remote', 'local_with_share']).default('remote'),
        /** Max events to retain on disk before rotation */
        maxEvents: z.number().default(10000),
        /** Days to retain local telemetry events */
        retentionDays: z.number().default(90),
        /**
         * Default remote endpoint. When `enabled=true`, system_profile /
         * heartbeat / error events get POSTed here. The TITAN project's
         * default collector is fronted by Tailscale Funnel pointing at the
         * Titan PC (SQLite-backed aggregation service under Tony's control).
         * Override with your own collector URL for self-hosting, or set to
         * empty string to disable remote send (events stay local only).
         */
        remoteUrl: z.string().default('https://dj-z690-steel-legend-d5.tail57901.ts.net/events'),
        /** Send crash reports (uncaught exceptions, unhandled rejections). */
        crashReports: z.boolean().default(true),
        /**
         * PostHog Cloud project API key (`phc_...`).
         *
         * The default below is the **public-write project key** for the
         * TITAN project's PostHog dashboard. PostHog `phc_` keys are
         * designed to be safely embedded in client code — they can ONLY
         * write events (capture/identify), never read data, modify
         * dashboards, or list other events. This is exactly how
         * Google Analytics IDs, Mixpanel tokens, and Sentry public DSNs
         * work. See https://posthog.com/docs/api#authentication.
         *
         * Why ship it: when a user opts in via the SetupWizard, telemetry
         * "just works" — no extra config, no collector to run. They send
         * straight to PostHog Cloud, which the project maintainer reads
         * via their personal API key. This is the simplest correct
         * architecture for opt-in OSS telemetry.
         *
         * Override with your own key for self-hosted PostHog or to send
         * to a different project. Set to empty string to disable PostHog
         * forwarding entirely (events still go to `remoteUrl` if set).
         */
        posthogApiKey: z.string().default('phc_kVw5xLJx5SVXex9RSTCFwP8cJSNEXTYZ7oJwqoDdMPJX'),
        /**
         * PostHog ingest host. Default is PostHog Cloud US.
         * Use 'https://eu.i.posthog.com' for EU data residency.
         */
        posthogHost: z.string().default('https://us.i.posthog.com'),
        /** ISO timestamp of consent (set by SetupWizard when user opts in). */
        consentedAt: z.string().optional(),
        /** Which TITAN version the user was on when they consented. */
        consentedVersion: z.string().optional(),
    }).default({}),
});

export type TitanConfig = z.infer<typeof TitanConfigSchema>;
export type TelemetryConfig = z.infer<typeof TitanConfigSchema>['telemetry'];
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type MeshConfig = z.infer<typeof MeshConfigSchema>;
export type AutopilotConfig = TitanConfig['autopilot'];
export type CapsolverConfig = z.infer<typeof CapsolverConfigSchema>;
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>;
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type TeachingConfig = z.infer<typeof TeachingConfigSchema>;
export type TeamConfig = z.infer<typeof TeamConfigSchema>;
export type NvidiaConfig = TitanConfig['nvidia'];
export type CommandPostConfig = TitanConfig['commandPost'];
export type EvalConfig = z.infer<typeof EvalConfigSchema>;
