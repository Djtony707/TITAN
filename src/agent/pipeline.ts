/**
 * TITAN — Task Pipeline System
 *
 * Routes tasks to specialized pipelines instead of running everything
 * through the same generic agent loop configuration. Each pipeline
 * controls: round budget, SmartExit rules, tool priorities, task enforcement,
 * and completion detection.
 *
 * Safety: if classification fails, falls back to 'general' which is
 * byte-for-byte equivalent to the pre-pipeline behavior.
 */

import logger from '../utils/logger.js';

const COMPONENT = 'Pipeline';

// ── Pipeline Types ──────────────────────────────────────────────────

export type PipelineType =
    | 'chat'
    | 'research'
    | 'code'
    | 'social'
    | 'content'
    | 'automation'
    | 'browser'
    | 'sysadmin'
    | 'analysis'
    | 'voice'
    | 'general';

export type CompletionStrategy =
    | 'smart-exit'      // Use pipeline-specific terminal tools
    | 'no-tools'        // Done when model stops calling tools
    | 'terminal-tool'   // Done when a specific tool succeeds
    | 'single-round';   // One tool round, then respond

// ── Pipeline Profile ────────────────────────────────────────────────

export interface PipelineProfile {
    name: string;
    type: PipelineType;
    description: string;

    // Round budget
    minRounds: number;
    maxRounds: number;

    // SmartExit configuration
    smartExitEnabled: boolean;
    terminalTools: string[];
    completionStrategy: CompletionStrategy;

    // Tool configuration — tools to ensure are in the active set
    ensureTools: string[];
    toolSearchEnabled: boolean;

    // Behavioral controls
    reflectionEnabled: boolean;
    reflectionInterval: number;
    taskEnforcement: string | null;
}

// ── Pipeline Profiles ───────────────────────────────────────────────

export const PIPELINE_PROFILES: Record<PipelineType, PipelineProfile> = {

    chat: {
        name: 'Chat',
        type: 'chat',
        description: 'Simple Q&A, greetings, casual conversation',
        minRounds: 0,
        maxRounds: 3,
        smartExitEnabled: true,
        terminalTools: ['weather', 'system_info', 'memory'],
        completionStrategy: 'single-round',
        ensureTools: ['memory', 'weather', 'system_info', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: false,
        reflectionInterval: 99,
        taskEnforcement: null,
    },

    research: {
        name: 'Research',
        type: 'research',
        description: 'Web research, fact-finding, information gathering',
        minRounds: 3,
        maxRounds: 15,
        smartExitEnabled: false,
        terminalTools: [],
        completionStrategy: 'no-tools',
        ensureTools: ['web_search', 'web_fetch', 'web_act', 'memory', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: true,
        reflectionInterval: 4,
        taskEnforcement: '[RESEARCH PIPELINE] You MUST call web_search at least 2 times with different queries to gather comprehensive information. After searching, use web_fetch to read the full content of the most relevant results. Do NOT answer from training data alone — the user wants current, real information.',
    },

    code: {
        name: 'Code',
        type: 'code',
        description: 'Code editing, debugging, implementation, refactoring',
        minRounds: 3,
        maxRounds: 12,
        smartExitEnabled: true,
        terminalTools: ['write_file', 'edit_file', 'append_file'],
        completionStrategy: 'terminal-tool',
        ensureTools: ['read_file', 'write_file', 'edit_file', 'append_file', 'list_dir', 'shell', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: true,
        reflectionInterval: 3,
        taskEnforcement: '[CODE PIPELINE] Follow this sequence:\n1. read_file to understand current code\n2. Plan your changes\n3. edit_file or write_file to make changes\n4. shell to verify (run tests, build, etc.)\nCRITICAL: Do NOT stop after reading files. You MUST call edit_file or write_file to save changes.',
    },

    social: {
        name: 'Social',
        type: 'social',
        description: 'Facebook posting, social media, comment replies',
        minRounds: 2,
        maxRounds: 10,
        smartExitEnabled: true,
        terminalTools: ['fb_post', 'fb_reply', 'content_publish', 'x_post'],
        completionStrategy: 'terminal-tool',
        ensureTools: ['web_search', 'web_fetch', 'fb_post', 'fb_read_feed', 'fb_reply', 'fb_review_queue', 'fb_autopilot_status', 'memory', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: false,
        reflectionInterval: 99,
        taskEnforcement: '[SOCIAL PIPELINE] For posting tasks:\n1. Research the topic first (web_search if needed)\n2. Compose the post content\n3. Use fb_post to publish it\nCRITICAL: You MUST call fb_post before finishing. Do NOT just describe what you would post — actually post it.',
    },

    content: {
        name: 'Content Creation',
        type: 'content',
        description: 'Multi-step content: research → write → publish',
        minRounds: 5,
        maxRounds: 20,
        smartExitEnabled: true,
        terminalTools: ['write_file', 'fb_post', 'content_publish', 'x_post'],
        completionStrategy: 'terminal-tool',
        ensureTools: ['web_search', 'web_fetch', 'read_file', 'write_file', 'edit_file', 'fb_post', 'memory', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: true,
        reflectionInterval: 5,
        taskEnforcement: '[CONTENT PIPELINE] This is a multi-step content creation task.\nPhase 1 — RESEARCH: Call web_search 2-3 times with different queries. Use web_fetch on top results.\nPhase 2 — SYNTHESIZE: Analyze what you found and draft content.\nPhase 3 — PUBLISH: Use the appropriate tool (write_file, fb_post, content_publish) to deliver the final result.\nDo NOT skip Phase 1. Do NOT stop after research without publishing.',
    },

    automation: {
        name: 'Automation',
        type: 'automation',
        description: 'Home automation, smart home, IoT control',
        minRounds: 1,
        maxRounds: 5,
        smartExitEnabled: true,
        terminalTools: ['ha_control', 'ha_setup'],
        completionStrategy: 'terminal-tool',
        ensureTools: ['ha_control', 'ha_status', 'ha_devices', 'ha_setup', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: false,
        reflectionInterval: 99,
        taskEnforcement: null,
    },

    browser: {
        name: 'Browser',
        type: 'browser',
        description: 'Browser automation, form filling, web interaction',
        minRounds: 3,
        maxRounds: 15,
        smartExitEnabled: false,
        terminalTools: [],
        completionStrategy: 'no-tools',
        ensureTools: ['web_act', 'smart_form_fill', 'web_search', 'web_fetch', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: true,
        reflectionInterval: 5,
        taskEnforcement: '[BROWSER PIPELINE] Navigate to the target page first, then interact with elements. Use web_act for clicking/typing, smart_form_fill for forms. Take screenshots to verify your actions.',
    },

    sysadmin: {
        name: 'System Admin',
        type: 'sysadmin',
        description: 'Shell commands, process management, deployments',
        minRounds: 2,
        maxRounds: 8,
        smartExitEnabled: true,
        terminalTools: ['shell'],
        completionStrategy: 'terminal-tool',
        ensureTools: ['shell', 'read_file', 'write_file', 'list_dir', 'system_info', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: false,
        reflectionInterval: 99,
        taskEnforcement: '[SYSADMIN PIPELINE] You MUST call the shell tool to execute commands. Do NOT describe what the command would do — run it and report the actual output.',
    },

    analysis: {
        name: 'Analysis',
        type: 'analysis',
        description: 'Data analysis, comparison, reporting',
        minRounds: 2,
        maxRounds: 10,
        smartExitEnabled: false,
        terminalTools: [],
        completionStrategy: 'no-tools',
        ensureTools: ['web_search', 'web_fetch', 'read_file', 'shell', 'memory', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: true,
        reflectionInterval: 3,
        taskEnforcement: '[ANALYSIS PIPELINE] Gather data from multiple sources before synthesizing. Use web_search and web_fetch for external data. Use read_file and shell for local data. Provide specific numbers and facts, not vague summaries.',
    },

    voice: {
        name: 'Voice',
        type: 'voice',
        description: 'Voice interactions (handled by existing voiceFastPath)',
        minRounds: 1,
        maxRounds: 3,
        smartExitEnabled: true,
        terminalTools: ['weather', 'system_info', 'ha_control'],
        completionStrategy: 'single-round',
        ensureTools: ['shell', 'web_search', 'weather', 'memory', 'ha_control', 'ha_devices', 'ha_status', 'tool_search'],
        toolSearchEnabled: true,
        reflectionEnabled: false,
        reflectionInterval: 99,
        taskEnforcement: null,
    },

    general: {
        name: 'General',
        type: 'general',
        description: 'Fallback — equivalent to pre-pipeline behavior',
        minRounds: 1,
        maxRounds: 0,  // 0 = use existing dynamic budget logic
        smartExitEnabled: true,
        terminalTools: ['write_file', 'append_file', 'weather', 'system_info', 'fb_post', 'fb_reply', 'content_publish'],
        completionStrategy: 'smart-exit',
        ensureTools: [],  // empty = use existing DEFAULT_CORE_TOOLS
        toolSearchEnabled: true,
        reflectionEnabled: true,
        reflectionInterval: 3,
        taskEnforcement: null,  // null = use existing scattered heuristics
    },
};

// ── Classifier ──────────────────────────────────────────────────────

/**
 * Classification rules — ordered by specificity (most specific first).
 * First match wins. If nothing matches, returns 'general'.
 */
const CLASSIFICATION_RULES: Array<{
    type: PipelineType;
    test: (msg: string, channel: string) => boolean;
}> = [
    // Voice is detected by channel, not message content
    {
        type: 'voice',
        test: (_msg, channel) => channel === 'voice',
    },

    // Social media — Facebook posting, replies, feed management
    {
        type: 'social',
        test: (msg) => /\b(fb_|facebook|post to .*(page|facebook|fb)|share on|comment.*repl|reply.*comment|read.*feed|check.*feed|autopilot.*status|post.*about|hype|comparison.*post)\b/i.test(msg),
    },

    // Home automation — smart home, IoT
    {
        type: 'automation',
        test: (msg) => /\b(ha_|home assistant|turn (on|off)|lights?|thermostat|temperature|smart home|sensor|switch|door|garage|lock|unlock|dim|brighten)\b/i.test(msg),
    },

    // Browser automation — form filling, web interaction
    {
        type: 'browser',
        test: (msg) => /\b(browse|navigate to|fill.*form|click.*button|log ?in to|sign ?in to|captcha|screenshot.*page|form[- ]fill|web.?act)\b/i.test(msg),
    },

    // Content creation — multi-step research + write + publish
    {
        type: 'content',
        test: (msg) => /\b(research.*and.*(write|post|publish|create)|write.*article|blog.*post|create.*content|draft.*report|write.*comparison)\b/i.test(msg)
                    && msg.split(/\s+/).length > 10,
    },

    // System administration — shell, deploy, restart, install
    {
        type: 'sysadmin',
        test: (msg) => /\b(run|execute|install|deploy|restart|start|stop|kill|ssh|systemctl|docker|npm run|git|build|compile|rsync|sudo|chmod|chown|service|process|daemon)\b/i.test(msg)
                    && /\b(command|server|service|package|app|container|process|cluster|node|pm2)\b/i.test(msg),
    },

    // Code editing — fix, edit, implement, debug
    {
        type: 'code',
        test: (msg) => /\b(fix|edit|change|modify|update|refactor|implement|add|remove|replace|rewrite|patch|upgrade|debug|wire|hook|create.*function|create.*class|create.*component)\b/i.test(msg)
                    && /\b(file|code|function|class|method|module|component|\.ts|\.js|\.py|\.tsx|\.jsx|bug|feature|error|test|endpoint|route|API|skill|tool)\b/i.test(msg),
    },

    // Research — web search, fact-finding
    {
        type: 'research',
        test: (msg) => /\b(research|investigate|find out|look up|what.*(latest|new|current|trending|happening)|compare.*framework|landscape|competitive|benchmark|how does.*work|what is|who is)\b/i.test(msg)
                    && msg.split(/\s+/).length > 6,
    },

    // Analysis — data analysis, reporting, comparison
    {
        type: 'analysis',
        test: (msg) => /\b(analyze|analysis|compare|report|breakdown|summary|summarize|overview|stats|statistics|metrics|dashboard|performance|trend|insight)\b/i.test(msg)
                    && msg.split(/\s+/).length > 6,
    },

    // Chat — simple Q&A, greetings (must be SHORT messages)
    {
        type: 'chat',
        test: (msg) => {
            const words = msg.trim().split(/\s+/).length;
            if (words > 15) return false;
            return /^(hi|hello|hey|yo|sup|what'?s up|good (morning|afternoon|evening)|thanks|thank you|ok|okay|sure|yes|no|help|how are you|who are you|what can you do)/i.test(msg.trim())
                || (words <= 8 && /^(what|who|how|why|where|when|is |are |do |does |can |will |tell me|explain)\b/i.test(msg.trim()));
        },
    },
];

/**
 * Classify a message into a pipeline type.
 * Fast regex-based classification — zero LLM cost.
 * Falls back to 'general' if nothing matches.
 */
export function classifyPipeline(message: string, channel: string): PipelineType {
    try {
        for (const rule of CLASSIFICATION_RULES) {
            if (rule.test(message, channel)) {
                logger.info(COMPONENT, `Classified as "${rule.type}": ${message.slice(0, 80)}...`);
                return rule.type;
            }
        }
        logger.info(COMPONENT, `Classified as "general" (no rule matched): ${message.slice(0, 80)}...`);
        return 'general';
    } catch (err) {
        logger.warn(COMPONENT, `Classification error, falling back to general: ${(err as Error).message}`);
        return 'general';
    }
}

/**
 * Resolve pipeline configuration for the agent loop.
 * Returns overrides that processMessage should apply.
 * For 'general' pipeline, returns null — use existing logic unchanged.
 */
export function resolvePipelineConfig(
    pipelineType: PipelineType,
    currentMaxRounds: number,
    hardCap: number,
): {
    maxRounds: number;
    smartExitEnabled: boolean;
    terminalTools: string[];
    reflectionEnabled: boolean;
    reflectionInterval: number;
    taskEnforcement: string | null;
    ensureTools: string[];
    completionStrategy: CompletionStrategy;
} | null {
    // General pipeline = no overrides, use existing behavior
    if (pipelineType === 'general') return null;

    const profile = PIPELINE_PROFILES[pipelineType];

    // Pipeline maxRounds: use profile's maxRounds, capped at hardCap
    // If profile maxRounds is 0, use the existing dynamic budget
    const maxRounds = profile.maxRounds > 0
        ? Math.min(profile.maxRounds, hardCap)
        : currentMaxRounds;

    return {
        maxRounds,
        smartExitEnabled: profile.smartExitEnabled,
        terminalTools: profile.terminalTools,
        reflectionEnabled: profile.reflectionEnabled,
        reflectionInterval: profile.reflectionInterval,
        taskEnforcement: profile.taskEnforcement,
        ensureTools: profile.ensureTools,
        completionStrategy: profile.completionStrategy,
    };
}
