/**
 * TITAN — Universal Sub-Agent
 * Spawns isolated sub-agents that reuse processMessage() with constrained toolsets.
 * Generalizes the swarm.ts pattern into a universal delegation system.
 *
 * Key constraints:
 * - Max depth: 1 (sub-agents cannot spawn sub-sub-agents)
 * - Inherits parent's autonomy mode (can't escalate)
 * - Own stall/loop counters (isolated from parent)
 * - Cost counts toward parent session budget
 */
import { chat } from '../providers/router.js';
import { executeTools, getToolDefinitions } from './toolRunner.js';
import { loadConfig } from '../config/config.js';
import type { ChatMessage, ToolDefinition } from '../providers/base.js';
import logger from '../utils/logger.js';
import { resolveToolsFromCategories, type ToolCategory } from './toolCategories.js';

const COMPONENT = 'SubAgent';

/** Currently running sub-agent count */
let activeSubAgents = 0;

export interface SubAgentConfig {
    name: string;
    task: string;
    /** Whitelist of tool names this sub-agent can use. Empty = all tools */
    tools?: string[];
    /** Tool categories — resolved to tool names at runtime */
    toolCategories?: ToolCategory[];
    /** Create a git worktree for filesystem isolation */
    useWorktree?: boolean;
    /** Model override (defaults to fast alias) */
    model?: string;
    /** Model tier — resolved via modelAliases (cloud/smart/fast/local) */
    tier?: ModelTier;
    /** System prompt override */
    systemPrompt?: string;
    /** Max tool rounds for this sub-agent (default: 10) */
    maxRounds?: number;
    /** Whether this is being called from within a sub-agent already */
    isNested?: boolean;
    /** Current nesting depth (0 = top-level sub-agent) */
    depth?: number;
    /** Progress callback: called each round with progress info */
    onProgress?: (round: number, totalRounds: number, agentName: string) => void;
    /** Stream callbacks for Agent Watcher — tool_call, tool_end, round events */
    streamCallbacks?: {
        onToolCall?: (name: string, args: Record<string, unknown>) => void;
        onToolResult?: (name: string, result: string, durationMs: number, success: boolean) => void;
        onThinking?: () => void;
        onRound?: (round: number, maxRounds: number) => void;
    };
}

export interface SubAgentResult {
    content: string;
    toolsUsed: string[];
    success: boolean;
    durationMs: number;
    rounds: number;
    /** Whether the output passed validation checks */
    validated: boolean;
}

/**
 * Model tier for each sub-agent template.
 * - 'cloud': Heavy reasoning tasks → uses modelAliases.cloud (big cloud model)
 * - 'smart': Complex tasks → uses modelAliases.smart
 * - 'fast': Quick/simple tasks → uses modelAliases.fast (local)
 * - 'local': Must run locally → uses modelAliases.local
 */
export type ModelTier = 'cloud' | 'smart' | 'fast' | 'local';

/** Built-in sub-agent templates */
export const SUB_AGENT_TEMPLATES: Record<string, Partial<SubAgentConfig> & { tier?: ModelTier }> = {
    explorer: {
        name: 'Explorer',
        tools: ['web_search', 'web_fetch', 'browse_url', 'web_read', 'web_act'],
        systemPrompt: `You are the Explorer sub-agent. Your job is to research and gather information from the web using your tools.

Available tools and when to use them:
- web_search: MUST use this first — search for any topic, question, or keyword
- web_fetch: MUST use after web_search — fetch full page content from the most relevant URLs
- browse_url: Navigate to a specific URL for interactive content
- web_read: Extract clean readable text from a URL
- web_act: Click, scroll, or interact with page elements

MUST rules:
- MUST call web_search before attempting to answer from memory
- MUST call web_fetch on at least 2 of the top search result URLs to get full content
- MUST cross-verify key facts across multiple sources

Return a structured summary with: key findings, sources (with URLs), and confidence level for main claims.`,
        tier: 'smart',
    },
    coder: {
        name: 'Coder',
        tools: ['shell', 'read_file', 'write_file', 'edit_file', 'append_file', 'list_dir', 'code_exec'],
        systemPrompt: `You are the Coder sub-agent. Your job is to write, read, and modify code using your tools.

Available tools and when to use them:
- list_dir: MUST use first to understand directory structure before writing anything
- read_file: MUST use before modifying any existing file — read it first
- write_file: MUST use to create new files — NEVER output code as text in your reply
- append_file: Use to add content to existing files incrementally (great for building HTML section by section)
- edit_file: MUST use to modify existing files — NEVER describe changes without making them
- shell: Run compilation, tests, package installs, or any system command
- code_exec: Run code in an isolated sandbox for quick testing

MUST rules:
- MUST call list_dir to explore the project before starting
- MUST call read_file before editing any existing file
- MUST call write_file or edit_file to save all code — never output code inline
- MUST call shell or code_exec to verify code runs correctly after writing

CRITICAL: Keep each edit under 30 lines. For large changes, make multiple small edit_file calls.
Return a summary of what was created/modified with exact file paths.`,
        tier: 'fast',
    },
    browser: {
        name: 'Browser',
        tools: ['browse_url', 'browser_auto_nav', 'browser_search', 'web_read', 'web_act', 'browser_screenshot'],
        systemPrompt: `You are the Browser sub-agent. Your job is to interact with web pages — navigate, extract content, fill forms, and click buttons.

Available tools and when to use them:
- browse_url: MUST use to navigate to a URL before interacting with it
- browser_screenshot: Take a screenshot to understand the current page state
- web_read: Extract clean text content from the current page
- web_act: Click buttons, fill inputs, scroll — use for interactive actions
- browser_auto_nav: Auto-navigate complex flows (login, multi-step forms)
- browser_search: Search within a page or site

MUST rules:
- MUST call browse_url first to open the page
- MUST call web_read or browser_screenshot to understand page contents before acting
- MUST report what you found, extracted, or accomplished with exact details

Return a clear report of what was found/done on the page.`,
        tier: 'fast',
    },
    analyst: {
        name: 'Analyst',
        tools: ['web_search', 'web_fetch', 'memory', 'graph_search', 'graph_remember'],
        systemPrompt: `You are the Analyst sub-agent. Your job is to analyze information, identify patterns, and produce structured analytical reports.

Available tools and when to use them:
- web_search: Search for data, statistics, reports, or comparisons
- web_fetch: Fetch full content from specific URLs for deeper analysis
- graph_search: Search the knowledge graph for previously stored context
- graph_remember: Store important findings in the knowledge graph for future reference
- memory: Store/retrieve key-value data points

MUST rules:
- MUST call web_search to gather current data before analyzing
- MUST call graph_search to check for existing relevant context
- MUST call graph_remember to store key findings after analysis
- MUST base conclusions on data from tools — not assumptions

Return a structured analytical report with: executive summary, data findings, patterns identified, confidence levels, and recommendations.`,
        tier: 'cloud',
    },
    researcher: {
        name: 'Researcher',
        tools: ['web_search', 'web_read', 'web_fetch', 'rag_search', 'rag_ingest'],
        systemPrompt: `You are the Deep Researcher sub-agent. Your job is to systematically research a question using multiple sources and tools.

Available tools and when to use them:
- web_search: MUST call 2-4 times with different targeted queries to get broad coverage
- web_fetch: MUST call on the top 3-5 URLs from search results to get full content
- web_read: Extract clean text from a URL
- rag_search: Search the local knowledge base for existing research on this topic
- rag_ingest: Store important findings in the local knowledge base

Methodology — follow in order:
1. Call rag_search to check for existing research on this topic
2. Break the question into 2-4 targeted search queries
3. Call web_search for each query
4. Call web_fetch on the most relevant URLs (at least 3 total)
5. Cross-verify key claims across at least 2 independent sources
6. Call rag_ingest to store important findings

MUST rules:
- MUST call web_search — never answer research questions from memory
- MUST call web_fetch to read full content, not just search snippets
- MUST cite all sources with URLs

Output format: executive summary → sections with headers → numbered citations [1], [2] → Sources list with URLs.`,
        maxRounds: 15,
        tier: 'cloud',
    },
    // ── Pipeline agents (DeerFlow-inspired) ────────────────────
    reporter: {
        name: 'Reporter',
        tools: ['read_file', 'write_file', 'web_fetch'],
        systemPrompt: `You are the Reporter sub-agent. Your job is to synthesize research findings into structured, publication-quality documents saved to disk.

Available tools and when to use them:
- read_file: Read any existing research notes or source files
- write_file: MUST use to save the final report to disk — NEVER output report content as text
- web_fetch: Fetch additional content from URLs if needed for a specific section

MUST rules:
- MUST call write_file to save the report — the output is a file on disk, not inline text
- MUST call read_file if source material files are referenced in the task
- If given a file path for the output, MUST save to exactly that path

Report structure: executive summary → sections with markdown headers → confidence levels (High/Medium/Low) per claim → numbered citations → actionable conclusions.`,
        maxRounds: 10,
        tier: 'cloud',
    },
    fact_checker: {
        name: 'Fact Checker',
        tools: ['web_search', 'web_fetch'],
        systemPrompt: `You are the Fact Checker sub-agent. Your job is to verify specific claims against multiple independent sources.

Available tools and when to use them:
- web_search: MUST call for each claim to find sources that confirm or refute it
- web_fetch: MUST call to read the full source content — search snippets are not enough

For each claim:
1. Call web_search with 2 different queries targeting this claim
2. Call web_fetch on the top 2 sources for full content
3. Compare the claim against what each source actually says
4. Assign: Verified (3+ sources agree) / Likely (2 sources) / Unverified (1 source) / Disputed (sources conflict) / False (sources contradict)

MUST rules:
- MUST call web_search for every claim — never verify from memory
- MUST call web_fetch to read full source content

Return a structured report: claim → status → evidence → sources used.`,
        maxRounds: 10,
        tier: 'smart',
    },
    // ── Dev agents (TITAN_DEV only) ──────────────────────────
    dev_debugger: {
        name: 'Dev Debugger',
        tools: ['shell', 'read_file', 'write_file', 'debug_analyze', 'code_analyze'],
        systemPrompt: `You are the Dev Debugger sub-agent for the TITAN framework. Your job is to find and fix bugs by reading actual code and running diagnostic commands.

Available tools and when to use them:
- read_file: MUST use to read the source file containing the error before diagnosing
- code_analyze: Analyze code structure, find potential issues, check for bugs
- debug_analyze: Deep analysis of error messages, stack traces, and runtime issues
- shell: Run the failing code, check logs, reproduce the error, verify the fix
- write_file: Save the fixed code

MUST rules:
- MUST call read_file to read the actual source code — never diagnose from assumptions
- MUST call code_analyze or debug_analyze to systematically identify the root cause
- MUST call shell to reproduce the error before attempting a fix
- MUST call shell again after the fix to verify it works
- MUST call write_file to apply the fix — never describe the fix without implementing it

Return: root cause analysis, fix applied (with file path), verification result.`,
        maxRounds: 15,
        tier: 'smart',
    },
    dev_tester: {
        name: 'Dev Tester',
        tools: ['shell', 'read_file', 'write_file', 'test_generate', 'code_exec'],
        systemPrompt: `You are the Dev Tester sub-agent for the TITAN framework. Your job is to generate, run, and fix tests using vitest.

Available tools and when to use them:
- read_file: MUST use to read the source code being tested before writing tests
- test_generate: Generate comprehensive test cases from source code
- write_file: MUST use to save the test file — never output tests as text
- shell: Run vitest to execute tests and see results
- code_exec: Quick isolated code execution for testing snippets

MUST rules:
- MUST call read_file to understand the code structure before writing tests
- MUST call write_file to save test files — never output tests inline
- MUST call shell to run the tests after writing them
- MUST fix any test failures — don't stop at writing tests

Return: test file path, number of tests written, test results (pass/fail counts).`,
        maxRounds: 20,
        tier: 'fast',
    },
    dev_reviewer: {
        name: 'Dev Reviewer',
        tools: ['shell', 'read_file', 'code_review', 'code_analyze', 'deps_audit'],
        systemPrompt: `You are the Dev Reviewer sub-agent for the TITAN framework. Your job is to perform thorough multi-pass code review.

Available tools and when to use them:
- read_file: MUST use to read each file being reviewed — never review from memory
- code_analyze: Structural analysis — complexity, patterns, architecture
- code_review: Deep review — security, logic errors, performance issues
- deps_audit: Check dependencies for vulnerabilities or outdated packages
- shell: Run the code, check for type errors, run linter

Review passes (do all):
1. Security pass: call code_review with security focus
2. Logic pass: call code_analyze for correctness and edge cases
3. Performance pass: check for inefficiencies
4. Dependencies pass: call deps_audit

MUST rules:
- MUST call read_file for each file reviewed
- MUST run at least 2 review passes with different focuses
- Flag real issues only — not style preferences

Return: structured findings by severity (Critical/Major/Minor), with file + line references.`,
        maxRounds: 10,
        tier: 'cloud',
    },
    dev_architect: {
        name: 'Dev Architect',
        tools: ['shell', 'read_file', 'write_file', 'code_analyze', 'refactor_suggest', 'doc_generate'],
        systemPrompt: `You are the Dev Architect sub-agent for the TITAN framework. Your job is to analyze system architecture and implement structural improvements.

Available tools and when to use them:
- read_file: MUST use to read source files before proposing architectural changes
- code_analyze: Analyze codebase structure, dependencies, coupling, and patterns
- refactor_suggest: Get suggestions for structural improvements and refactoring
- shell: Run the codebase to understand runtime behavior, check imports, count lines
- write_file: MUST use to implement changes or create documentation
- doc_generate: Generate architectural documentation

MUST rules:
- MUST call read_file and code_analyze before proposing any changes — never guess at structure
- MUST call shell to understand actual file/folder organization
- MUST call write_file to implement changes or save documentation — never describe changes inline
- Think in systems and dependencies, not individual files

Return: architectural analysis, proposed changes with rationale, implementation summary with file paths.`,
        maxRounds: 15,
        tier: 'cloud',
    },
};

/**
 * Spawn a sub-agent that runs an isolated agent loop with constrained tools.
 * Returns when the sub-agent completes its task.
 */
export async function spawnSubAgent(config: SubAgentConfig): Promise<SubAgentResult> {
    const titanConfig = loadConfig();
    const startTime = Date.now();
    const currentDepth = config.depth ?? 0;
    const subAgentsCfg = (titanConfig as Record<string, unknown>).subAgents as Record<string, unknown> | undefined;
    const maxDepth = (subAgentsCfg?.maxDepth as number) ?? 4; // Increased from 2 → 4 for multi-level task decomposition

    // Check depth limit (configurable, default 2)
    if (currentDepth >= maxDepth || config.isNested) {
        return {
            content: `Error: Sub-agent nesting depth limit reached (depth ${currentDepth}/${maxDepth}).`,
            toolsUsed: [],
            success: false,
            durationMs: 0,
            rounds: 0,
            validated: false,
        };
    }

    // Check concurrency limit
    const maxConcurrent = (titanConfig as Record<string, unknown>).subAgents
        ? ((titanConfig as Record<string, unknown>).subAgents as Record<string, unknown>).maxConcurrent as number || 3
        : 3;

    if (activeSubAgents >= maxConcurrent) {
        return {
            content: `Error: Maximum concurrent sub-agents (${maxConcurrent}) reached. Wait for one to finish.`,
            toolsUsed: [],
            success: false,
            durationMs: 0,
            rounds: 0,
            validated: false,
        };
    }

    activeSubAgents++;
    const agentName = config.name || 'SubAgent';
    // Reduce max rounds by 30% per depth level to prevent runaway nesting
    const baseMaxRounds = config.maxRounds || 10;
    const depthReduction = Math.pow(0.7, currentDepth);
    const maxRounds = Math.max(3, Math.ceil(baseMaxRounds * depthReduction));
    // Model resolution priority:
    // 1. Explicit model passed in config (full model ID like 'ollama/qwen3.5:397b-cloud')
    // 2. Tier from config/template → resolve via modelAliases (cloud/smart/fast/local)
    // 3. subAgents.defaultModel config → resolve as alias name
    // 4. modelAliases.fast fallback
    const aliases = titanConfig.agent.modelAliases || {};
    const subDefaultAlias = (subAgentsCfg?.defaultModel as string) || 'fast';
    const tier = config.tier;
    const model = config.model
        || (tier ? aliases[tier] : undefined)
        || aliases[subDefaultAlias]
        || aliases.fast
        || 'openai/gpt-4o-mini';

    logger.info(COMPONENT, `Spawning ${agentName}: "${config.task.slice(0, 80)}..." (model: ${model}, maxRounds: ${maxRounds})`);

    // Build tool whitelist
    let availableTools: ToolDefinition[];
    const allTools = getToolDefinitions();

    const canNest = currentDepth + 1 < maxDepth; // Allow spawn_agent only if depth allows
    if (config.tools && config.tools.length > 0) {
        const toolSet = new Set(config.tools);
        if (!canNest) toolSet.delete('spawn_agent');
        availableTools = allTools.filter(t => toolSet.has(t.function.name));
    } else {
        availableTools = allTools.filter(t => canNest || t.function.name !== 'spawn_agent');
    }

    const systemPrompt = config.systemPrompt || `You are the ${agentName} sub-agent of TITAN. Execute the task below using available tools. Be efficient and return a clear summary when done.`;

    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: config.task },
    ];

    const toolsUsed: string[] = [];
    let finalContent = '';
    let rounds = 0;

    try {
        for (let round = 0; round < maxRounds; round++) {
            rounds = round + 1;
            logger.debug(COMPONENT, `[${agentName}] Round ${rounds}/${maxRounds}`);
            config.onProgress?.(rounds, maxRounds, agentName);

            const response = await chat({
                model,
                messages,
                tools: availableTools.length > 0 ? availableTools : undefined,
                maxTokens: titanConfig.agent.maxTokens || 4096,
                temperature: 0.2,
            });

            // No tool calls = done
            if (!response.toolCalls || response.toolCalls.length === 0) {
                finalContent = response.content || 'Task completed.';
                break;
            }

            // Process tool calls
            messages.push({
                role: 'assistant',
                content: response.content || '',
                toolCalls: response.toolCalls,
            });

            // Emit tool_call events for Agent Watcher
            if (config.streamCallbacks?.onToolCall) {
                for (const tc of response.toolCalls!) { config.streamCallbacks.onToolCall(tc.function.name, JSON.parse(tc.function.arguments || "{}")); }
            }
            const toolResults = await executeTools(response.toolCalls);
            // Emit tool_end events for Agent Watcher
            if (config.streamCallbacks?.onToolResult) {
                for (const tr of toolResults) { config.streamCallbacks.onToolResult(tr.name, tr.content, tr.durationMs || 0, tr.success !== false); }
            }

            for (const result of toolResults) {
                toolsUsed.push(result.name);
                messages.push({
                    role: 'tool',
                    content: result.content,
                    toolCallId: result.toolCallId,
                    name: result.name,
                });
            }

            // Last round fallback
            if (round === maxRounds - 1) {
                finalContent = response.content || 'Max rounds reached. Partial results returned.';
            }
        }

        const durationMs = Date.now() - startTime;
        logger.info(COMPONENT, `${agentName} completed in ${durationMs}ms (${rounds} rounds, ${toolsUsed.length} tool calls)`);

        // Output validation: check for empty, too-short, or error-like responses
        const validated = validateSubAgentOutput(finalContent);
        if (!validated) {
            logger.warn(COMPONENT, `[${agentName}] Output failed validation: "${finalContent.slice(0, 80)}..."`);
        }

        return {
            content: finalContent,
            toolsUsed: [...new Set(toolsUsed)],
            success: !finalContent.toLowerCase().startsWith('error') && validated,
            durationMs,
            rounds,
            validated,
        };
    } catch (err) {
        const durationMs = Date.now() - startTime;
        logger.error(COMPONENT, `${agentName} failed: ${(err as Error).message}`);
        return {
            content: `Sub-agent error: ${(err as Error).message}`,
            toolsUsed: [...new Set(toolsUsed)],
            success: false,
            durationMs,
            rounds,
            validated: false,
        };
    } finally {
        activeSubAgents--;
    }
}

/** Validate sub-agent output for quality */
function validateSubAgentOutput(content: string): boolean {
    if (!content || content.trim().length < 20) return false;
    const lower = content.toLowerCase();
    if (lower.startsWith('i cannot') || lower.startsWith('i\'m unable') || lower.startsWith('i am unable')) return false;
    if (lower.startsWith('error:') || lower.startsWith('sub-agent error:')) return false;
    if (lower === 'task completed.' && content.length < 20) return false;
    return true;
}

/** Get count of currently active sub-agents */
export function getActiveSubAgentCount(): number {
    return activeSubAgents;
}
