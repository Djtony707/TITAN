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
});

export const ChannelConfigSchema = z.object({
    enabled: z.boolean().default(false),
    token: z.string().optional(),
    apiKey: z.string().optional(),
    allowFrom: z.array(z.string()).default([]),
    dmPolicy: z.enum(['pairing', 'open', 'closed']).default('pairing'),
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
    modelAliases: z.record(z.string(), z.string()).default({
        fast: 'openai/gpt-4o-mini',
        smart: 'anthropic/claude-sonnet-4-20250514',
        reasoning: 'openai/o3-mini',
        cheap: 'google/gemini-2.0-flash',
        local: 'ollama/qwen3.5:4b',
        cloud: 'ollama/qwen3.5:397b-cloud',
    }),
    costOptimization: z.object({
        smartRouting: z.boolean().default(true),
        contextSummarization: z.boolean().default(true),
        dailyBudgetUsd: z.number().optional(),
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
    ttsVoice: z.string().default('tara'),
    /** TTS engine: orpheus | f5-tts | fish-speech | edge | browser */
    ttsEngine: z.enum(['orpheus', 'f5-tts', 'qwen3-tts', 'fish-speech', 'edge', 'browser']).default('orpheus'),
    /** TTS server URL (Orpheus: 5005) */
    ttsUrl: z.string().default('http://localhost:5005'),
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

export const TitanConfigSchema = z.object({
    /** Whether the user has completed the web onboarding wizard */
    onboarded: z.boolean().default(false),
    agent: AgentConfigSchema.default({}),
    providers: z.object({
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
    }).default({}),
    gateway: GatewayConfigSchema.default({}),
    security: SecurityConfigSchema.default({}),
    memory: z.object({
        enabled: z.boolean().default(true),
        maxHistoryMessages: z.number().default(50),
        /** Enable semantic vector search via Ollama embeddings (Tier 2 memory) */
        vectorSearchEnabled: z.boolean().default(false),
        /** Embedding model for vector search (must be available on Ollama) */
        embeddingModel: z.string().default('nomic-embed-text'),
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
        /** Base model to fine-tune */
        baseModel: z.string().default('qwen3.5:35b'),
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
            orpheus_tts: { estimatedMB: 4000, priority: 2, type: 'docker' },
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
    }).default({}),
});

export type TitanConfig = z.infer<typeof TitanConfigSchema>;
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
