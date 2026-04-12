/**
 * TITAN — Skills Registry
 * Discovers, loads, and manages skills from bundled, workspace, and marketplace sources.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import vm from 'vm';
import { TITAN_HOME, TITAN_SKILLS_DIR } from '../utils/constants.js';
import { registerTool, type ToolHandler } from '../agent/toolRunner.js';
import { ensureDir } from '../utils/helpers.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Skills';
const DISABLED_SKILLS_PATH = join(TITAN_HOME, 'disabled-skills.json');

export interface SkillMeta {
    name: string;
    description: string;
    version: string;
    author?: string;
    source: 'bundled' | 'workspace' | 'marketplace';
    enabled: boolean;
}

const registeredSkills: Map<string, SkillMeta> = new Map();

/** Maps skill name → tool names belonging to that skill */
const skillToolMap: Map<string, Set<string>> = new Map();

/** Register a built-in skill (tool handler + metadata) */
export function registerSkill(meta: SkillMeta, handler: ToolHandler): void {
    registeredSkills.set(meta.name, meta);
    // Track which tools belong to this skill
    if (!skillToolMap.has(meta.name)) {
        skillToolMap.set(meta.name, new Set());
    }
    skillToolMap.get(meta.name)!.add(handler.name);
    registerTool(handler);
    logger.debug(COMPONENT, `Registered skill: ${meta.name} (${meta.source})`);
}

/** Get all registered skills (with persisted enabled/disabled state applied) */
export function getSkills(): SkillMeta[] {
    const disabled = loadDisabledSkills();
    return Array.from(registeredSkills.values()).map(s => ({
        ...s,
        enabled: !disabled.includes(s.name),
    }));
}

/** Get a skill by name */
export function getSkill(name: string): SkillMeta | undefined {
    return registeredSkills.get(name);
}

/** Get tool names belonging to a skill */
export function getSkillTools(skillName: string): string[] {
    return Array.from(skillToolMap.get(skillName) || []);
}

/** Check if a skill is enabled */
export function isSkillEnabled(skillName: string): boolean {
    return !loadDisabledSkills().includes(skillName);
}

/** Check if a specific tool's parent skill is enabled */
export function isToolSkillEnabled(toolName: string): boolean {
    for (const [skillName, tools] of skillToolMap.entries()) {
        if (tools.has(toolName)) {
            return isSkillEnabled(skillName);
        }
    }
    return true; // Tools not belonging to any skill are always enabled
}

/** Toggle a skill on/off. Returns the new enabled state. */
export function toggleSkill(skillName: string): boolean {
    const skill = registeredSkills.get(skillName);
    if (!skill) {
        throw new Error(`Skill "${skillName}" not found`);
    }

    const disabled = loadDisabledSkills();
    const idx = disabled.indexOf(skillName);
    let nowEnabled: boolean;

    if (idx >= 0) {
        disabled.splice(idx, 1);
        nowEnabled = true;
    } else {
        disabled.push(skillName);
        nowEnabled = false;
    }

    saveDisabledSkills(disabled);
    logger.info(COMPONENT, `Skill "${skillName}" ${nowEnabled ? 'enabled' : 'disabled'}`);
    return nowEnabled;
}

/** Set a skill's enabled state explicitly */
export function setSkillEnabled(skillName: string, enabled: boolean): void {
    const skill = registeredSkills.get(skillName);
    if (!skill) {
        throw new Error(`Skill "${skillName}" not found`);
    }

    const disabled = loadDisabledSkills();
    const idx = disabled.indexOf(skillName);

    if (enabled && idx >= 0) {
        disabled.splice(idx, 1);
    } else if (!enabled && idx < 0) {
        disabled.push(skillName);
    }

    saveDisabledSkills(disabled);
}

/** Load disabled skills list from disk */
function loadDisabledSkills(): string[] {
    try {
        if (existsSync(DISABLED_SKILLS_PATH)) {
            return JSON.parse(readFileSync(DISABLED_SKILLS_PATH, 'utf-8')) as string[];
        }
    } catch {
        // Corrupt file — treat as empty
    }
    return [];
}

/** Save disabled skills list to disk */
function saveDisabledSkills(disabled: string[]): void {
    try {
        const dir = dirname(DISABLED_SKILLS_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(DISABLED_SKILLS_PATH, JSON.stringify(disabled, null, 2), 'utf-8');
    } catch (e) {
        logger.warn(COMPONENT, `Failed to save disabled skills: ${(e as Error).message}`);
    }
}

/** Discover workspace skills from ~/.titan/workspace/skills/ */
export function discoverWorkspaceSkills(): SkillMeta[] {
    ensureDir(TITAN_SKILLS_DIR);
    const discovered: SkillMeta[] = [];

    if (!existsSync(TITAN_SKILLS_DIR)) return discovered;

    const entries = readdirSync(TITAN_SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(TITAN_SKILLS_DIR, entry.name);
        const skillMdPath = join(skillDir, 'SKILL.md');

        if (!existsSync(skillMdPath)) continue;

        try {
            const content = readFileSync(skillMdPath, 'utf-8');
            const meta = parseSkillMd(content, entry.name);
            if (meta) {
                discovered.push({ ...meta, source: 'workspace', enabled: true });
            }
        } catch (error) {
            logger.warn(COMPONENT, `Failed to load skill ${entry.name}: ${(error as Error).message}`);
        }
    }

    logger.info(COMPONENT, `Discovered ${discovered.length} workspace skills`);
    return discovered;
}

/** Parse SKILL.md frontmatter to extract metadata */
function parseSkillMd(content: string, fallbackName: string): Omit<SkillMeta, 'source' | 'enabled'> | null {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
        return {
            name: fallbackName,
            description: content.split('\n')[0] || 'No description',
            version: '1.0.0',
        };
    }

    const frontmatter = frontmatterMatch[1];
    const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim() || fallbackName;
    const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim() || 'No description';
    const version = frontmatter.match(/version:\s*(.+)/)?.[1]?.trim() || '1.0.0';
    const author = frontmatter.match(/author:\s*(.+)/)?.[1]?.trim();

    return { name, description, version, author };
}

/** Initialize all built-in skills */
export async function initBuiltinSkills(): Promise<void> {
    logger.info(COMPONENT, 'Loading built-in skills...');

    // Import and register built-in skills
    const { registerShellSkill } = await import('./builtin/shell.js');
    const { registerFilesystemSkill } = await import('./builtin/filesystem.js');
    const { registerWebSearchSkill } = await import('./builtin/web_search.js');
    const { registerCronSkill } = await import('./builtin/cron.js');
    const { registerWebhookSkill } = await import('./builtin/webhook.js');
    const { registerMemorySkill } = await import('./builtin/memory_skill.js');
    const { registerBrowserSkill } = await import('./builtin/browser.js');
    const { registerSessionsSkill } = await import('./builtin/sessions.js');
    const { registerProcessSkill } = await import('./builtin/process.js');
    const { registerWebFetchSkill } = await import('./builtin/web_fetch.js');
    const { registerApplyPatchSkill } = await import('./builtin/apply_patch.js');
    const { registerAutoGenerateSkill } = await import('./builtin/auto_generate.js');
    const { registerVisionSkill } = await import('./builtin/vision.js');
    const { registerVoiceSkills } = await import('./builtin/voice.js');
    const { registerMemoryGraphSkill } = await import('./builtin/memory_graph.js');
    const { initWebBrowserTool } = await import('./builtin/web_browser.js');
    const { registerGitHubSkill } = await import('./builtin/github.js');
    const { registerEmailSkill } = await import('./builtin/email.js');
    const { registerComputerUseSkill } = await import('./builtin/computer_use.js');
    const { registerImageGenSkill } = await import('./builtin/image_gen.js');
    const { registerPdfSkill } = await import('./builtin/pdf.js');
    const { registerCalendarSkill } = await import('./builtin/calendar.js');
    const { registerSmartHomeSkill } = await import('./builtin/smart_home.js');
    const { registerDataAnalysisSkill } = await import('./builtin/data_analysis.js');
    const { registerSkyvernSkill } = await import('./builtin/skyvern.js');
    const { registerWebBrowseLlmSkill } = await import('./builtin/web_browse_llm.js');
    const { registerIncomeTrackerSkill } = await import('./builtin/income_tracker.js');
    const { registerFreelanceMonitorSkill } = await import('./builtin/freelance_monitor.js');
    const { registerContentPublisherSkill } = await import('./builtin/content_publisher.js');
    const { registerLeadScorerSkill } = await import('./builtin/lead_scorer.js');
    const { registerHunterSkill } = await import('./builtin/hunter.js');
    const { registerCodeExecSkill } = await import('./builtin/code_exec.js');
    const { registerWeatherSkill } = await import('./builtin/weather.js');
    const { registerGoalsSkill } = await import('./builtin/goals.js');
    const { registerXPosterSkill } = await import('./builtin/x_poster.js');
    const { initModelSwitchTool } = await import('./builtin/model_switch.js');
    const { registerRagSkill } = await import('./builtin/rag.js');
    const { registerDeepResearchSkill } = await import('./builtin/deep_research.js');
    const { registerSystemInfoSkill } = await import('./builtin/system_info.js');
    const { registerPersonaManagerSkill } = await import('./builtin/persona_manager.js');
    const { registerResearchPipelineSkill } = await import('./builtin/research_pipeline.js');
    const { registerAutoresearchSkill } = await import('./builtin/autoresearch.js');
    const { registerSelfDoctorSkill } = await import('./builtin/self_doctor.js');
    const { registerInteractionTrackerSkill } = await import('./builtin/interaction_tracker.js');
    const { registerFeedbackTrackerSkill } = await import('./builtin/feedback_tracker.js');
    const { registerGrowthExperimentsSkill } = await import('./builtin/growth_experiments.js');
    const { registerContentCalendarSkill } = await import('./builtin/content_calendar.js');
    const { registerSlackSkill } = await import('./builtin/slack.js');
    const { registerRevenueCatKBSkill } = await import('./builtin/revenuecat_kb.js');
    const { registerWeeklyReportSkill } = await import('./builtin/weekly_report.js');
    const { registerSelfImproveSkill } = await import('./builtin/self_improve.js');
    const { registerGepaSkill } = await import('./builtin/gepa.js');
    const { registerModelTrainerSkill } = await import('./builtin/model_trainer.js');
    const { registerSocialSchedulerSkill } = await import('./builtin/social_scheduler.js');
    const { registerStructuredOutputSkill } = await import('./builtin/structured_output.js');
    const { registerWorkflowsSkill } = await import('./builtin/workflows.js');
    const { registerAgentHandoffSkill } = await import('./builtin/agent_handoff.js');
    const { registerKnowledgeBaseSkill } = await import('./builtin/knowledge_base.js');
    const { registerEventTriggersSkill } = await import('./builtin/event_triggers.js');
    const { registerA2AProtocolSkill } = await import('./builtin/a2a_protocol.js');
    const { registerEvalsSkill } = await import('./builtin/evals.js');
    const { registerApprovalGatesSkill } = await import('./builtin/approval_gates.js');
    const { registerVRAMSkills } = await import('./builtin/vram.js');
    const { registerSecurityScanSkill } = await import('./builtin/security_scan.js');
    const { registerChangelogGenSkill } = await import('./builtin/changelog_gen.js');
    const { registerJiraLinearSkill } = await import('./builtin/jira_linear.js');
    const { registerAuditTrailSkill } = await import('./builtin/audit_trail.js');
    const { registerVisualPlanSkill } = await import('./builtin/visual_plan.js');
    const { registerScreenRecordSkill } = await import('./builtin/screen_record.js');
    const { registerSessionTeleportSkill } = await import('./builtin/session_teleport.js');
    const { registerCrossProviderSkill } = await import('./builtin/cross_provider.js');
    const { registerSentrySkill } = await import('./builtin/sentry.js');
    const { registerVideoSkill } = await import('./builtin/video.js');
    const { registerMixtureOfAgentsSkill } = await import('./builtin/mixture_of_agents.js');
    const { registerFileCheckpointsSkill } = await import('./builtin/file_checkpoints.js');
    const { registerVerifyPageSkill } = await import('./builtin/verify_page.js');

    const registrations: [string, () => void][] = [
        ['shell', registerShellSkill],
        ['filesystem', registerFilesystemSkill],
        ['web_search', registerWebSearchSkill],
        ['cron', registerCronSkill],
        ['webhook', registerWebhookSkill],
        ['memory', registerMemorySkill],
        ['browser', registerBrowserSkill],
        ['sessions', registerSessionsSkill],
        ['process', registerProcessSkill],
        ['web_fetch', registerWebFetchSkill],
        ['apply_patch', registerApplyPatchSkill],
        ['auto_generate', registerAutoGenerateSkill],
        ['vision', registerVisionSkill],
        ['voice', registerVoiceSkills],
        ['memory_graph', registerMemoryGraphSkill],
        ['web_browser', initWebBrowserTool],
        ['github', registerGitHubSkill],
        ['email', registerEmailSkill],
        ['computer_use', registerComputerUseSkill],
        ['image_gen', registerImageGenSkill],
        ['pdf', registerPdfSkill],
        ['calendar', registerCalendarSkill],
        ['smart_home', registerSmartHomeSkill],
        ['data_analysis', registerDataAnalysisSkill],
        ['skyvern', registerSkyvernSkill],
        ['web_browse_llm', registerWebBrowseLlmSkill],
        ['income_tracker', registerIncomeTrackerSkill],
        ['freelance_monitor', registerFreelanceMonitorSkill],
        ['content_publisher', registerContentPublisherSkill],
        ['lead_scorer', registerLeadScorerSkill],
        ['hunter', registerHunterSkill],
        ['code_exec', registerCodeExecSkill],
        ['weather', registerWeatherSkill],
        ['goals', registerGoalsSkill],
        ['x_poster', registerXPosterSkill],
        ['model_switch', initModelSwitchTool],
        ['rag', registerRagSkill],
        ['deep_research', registerDeepResearchSkill],
        ['system_info', registerSystemInfoSkill],
        ['persona_manager', registerPersonaManagerSkill],
        ['research_pipeline', registerResearchPipelineSkill],
        ['autoresearch', registerAutoresearchSkill],
        ['self_doctor', registerSelfDoctorSkill],
        ['interaction_tracker', registerInteractionTrackerSkill],
        ['feedback_tracker', registerFeedbackTrackerSkill],
        ['growth_experiments', registerGrowthExperimentsSkill],
        ['content_calendar', registerContentCalendarSkill],
        ['slack', registerSlackSkill],
        ['revenuecat_kb', registerRevenueCatKBSkill],
        ['weekly_report', registerWeeklyReportSkill],
        ['self_improve', registerSelfImproveSkill],
        ['gepa', registerGepaSkill],
        ['model_trainer', registerModelTrainerSkill],
        ['social_scheduler', registerSocialSchedulerSkill],
        ['structured_output', registerStructuredOutputSkill],
        ['workflows', registerWorkflowsSkill],
        ['agent_handoff', registerAgentHandoffSkill],
        ['knowledge_base', registerKnowledgeBaseSkill],
        ['event_triggers', registerEventTriggersSkill],
        ['evals', registerEvalsSkill],
        ['a2a_protocol', registerA2AProtocolSkill],
        ['approval_gates', registerApprovalGatesSkill],
        ['vram', registerVRAMSkills],
        ['security_scan', registerSecurityScanSkill],
        ['changelog_gen', registerChangelogGenSkill],
        ['jira_linear', registerJiraLinearSkill],
        ['audit_trail', registerAuditTrailSkill],
        ['visual_plan', registerVisualPlanSkill],
        ['screen_record', registerScreenRecordSkill],
        ['session_teleport', registerSessionTeleportSkill],
        ['cross_provider', registerCrossProviderSkill],
        ['sentry', registerSentrySkill],
        ['video', registerVideoSkill],
        ['mixture_of_agents', registerMixtureOfAgentsSkill],
        ['file_checkpoints', registerFileCheckpointsSkill],
        ['verify_page', registerVerifyPageSkill],
    ];

    for (const [name, fn] of registrations) {
        try { fn(); } catch (e) { logger.warn(COMPONENT, `Failed to register skill "${name}": ${(e as Error).message}`); }
    }

    // Register planner as an LLM-invocable tool
    const { registerPlannerTool } = await import('../agent/planner.js');
    try { registerPlannerTool(); } catch (e) { logger.warn(COMPONENT, `Failed to register planner: ${(e as Error).message}`); }

    // Register TopFacts context engine plugin (DeerFlow-inspired persistent memory)
    try {
        const { createTopFactsPlugin } = await import('../plugins/topFacts.js');
        const { registerPlugin } = await import('../plugins/registry.js');
        const topFacts = createTopFactsPlugin();
        registerPlugin(topFacts);
        if (topFacts.bootstrap) await topFacts.bootstrap({});
    } catch (e) { logger.warn(COMPONENT, `Failed to register TopFacts plugin: ${(e as Error).message}`); }

    // Register SmartCompress context engine plugin (task-type-aware compression)
    try {
        const { createSmartCompressPlugin } = await import('../plugins/smartCompress.js');
        const { registerPlugin: regPlugin } = await import('../plugins/registry.js');
        const smartCompress = createSmartCompressPlugin();
        regPlugin(smartCompress);
        if (smartCompress.bootstrap) await smartCompress.bootstrap({});
    } catch (e) { logger.warn(COMPONENT, `Failed to register SmartCompress plugin: ${(e as Error).message}`); }

    // Register tool_search — meta-tool for discovering tools on demand
    const { getToolSearchHandler } = await import('../agent/toolSearch.js');
    try { registerTool(getToolSearchHandler()); } catch (e) { logger.warn(COMPONENT, `Failed to register tool_search: ${(e as Error).message}`); }

    logger.info(COMPONENT, `Loaded ${registeredSkills.size} built-in skills`);

    // Load dev skills (only in dev mode — skip import entirely in production)
    if (process.env.NODE_ENV !== 'production' || process.env.TITAN_DEV) {
        const { initDevSkills } = await import('./dev/loader.js');
        await initDevSkills();
    }

    // Load NVIDIA skills (optional — only when TITAN_NVIDIA=1 or nvidia.enabled in config)
    try {
        let nvidiaEnabled = process.env.TITAN_NVIDIA === '1';
        if (!nvidiaEnabled) {
            try {
                const { loadConfig: _loadConfig } = await import('../config/config.js');
                const cfg = _loadConfig() as Record<string, unknown>;
                const nvCfg = cfg.nvidia as Record<string, unknown> | undefined;
                nvidiaEnabled = nvCfg?.enabled === true;
            } catch { /* config not available in test env */ }
        }
        if (nvidiaEnabled) {
            const { initNvidiaSkills } = await import('./nvidia/loader.js');
            await initNvidiaSkills();
        }
    } catch (err) {
        logger.warn(COMPONENT, `NVIDIA skills failed to load: ${(err as Error).message}`);
    }

    // Load personal skills (private, gitignored — only when TITAN_PERSONAL=1)
    // Primary location: dist/skills/personal/loader.js (co-located with dist/skills/registry.js
    //   so `../registry` resolves to the SAME module instance — tools register into the correct registry)
    // Fallback: ~/.titan/personal/loader.js (legacy / TITAN_PERSONAL_DIR override)
    if (process.env.TITAN_PERSONAL === '1') {
        try {
            const { pathToFileURL, fileURLToPath } = await import('node:url');
            const { join: _join, dirname: _dirname } = await import('node:path');
            // Compute dist/skills/ dir from this file's location (works on any machine)
            const thisDir = _dirname(fileURLToPath(import.meta.url));
            const distPersonalDir = _join(thisDir, 'personal');
            // TITAN_PERSONAL_DIR env var overrides; otherwise try dist-local first, then ~/.titan/personal/
            const personalDir = process.env.TITAN_PERSONAL_DIR
                || (existsSync(_join(distPersonalDir, 'loader.js')) ? distPersonalDir : _join(TITAN_HOME, 'personal'));
            const loaderPath = _join(personalDir, 'loader.js');
            if (existsSync(loaderPath)) {
                // Inject the main app's registerSkill into a global so the personal bundle
                // (which has its own bundled copy) uses the correct shared toolRegistry instance.
                (globalThis as Record<string, unknown>).__titanRegisterSkill = registerSkill;
                const { initPersonalSkills } = await import(pathToFileURL(loaderPath).href) as { initPersonalSkills: () => Promise<void> };
                await initPersonalSkills();
            } else {
                logger.warn(COMPONENT, `TITAN_PERSONAL=1 but ${loaderPath} not found — run: npm run build:personal`);
            }
        } catch (err) {
            logger.warn(COMPONENT, `Personal skills failed to load: ${(err as Error).message}`);
        }
    }
}

/**
 * Discover and load user skills from ~/.titan/skills/ (all subdirs).
 * Supports:
 *  1. JavaScript files (.js) that export default { name, description, parameters, execute }
 *  2. YAML skill definitions (.yaml/.yml) with inline scripts
 *  3. Auto-generated skills from ~/.titan/skills/auto/
 */
export async function loadAutoSkills(): Promise<void> {
    const skillsRoot = join(TITAN_HOME, 'skills');
    if (!existsSync(skillsRoot)) return;

    logger.info(COMPONENT, 'Scanning for user skills...');
    let loadedCount = 0;

    // Scan both root and all subdirectories
    const dirsToScan = [skillsRoot];
    const entries = readdirSync(skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) dirsToScan.push(join(skillsRoot, entry.name));
    }

    for (const dir of dirsToScan) {
        const files = readdirSync(dir).filter(f =>
            f.endsWith('.js') || f.endsWith('.yaml') || f.endsWith('.yml')
        );

        for (const file of files) {
            const filePath = join(dir, file);
            try {
                if (file.endsWith('.js')) {
                    // JavaScript skill — export default { name, description, parameters, execute }
                    const modulePath = `file://${filePath}?t=${Date.now()}`;
                    const mod = await import(modulePath);
                    if (mod.default && mod.default.name && mod.default.execute) {
                        const handler = mod.default as ToolHandler;
                        if (registeredSkills.has(handler.name)) continue; // Skip duplicates
                        registerSkill({
                            name: handler.name,
                            description: handler.description || 'User skill',
                            version: '1.0.0',
                            source: 'workspace',
                            enabled: true,
                        }, handler);
                        loadedCount++;
                    }
                } else {
                    // YAML skill definition
                    const loaded = loadYamlSkill(filePath);
                    if (loaded && !registeredSkills.has(loaded.name)) {
                        registerSkill({
                            name: loaded.name,
                            description: loaded.description,
                            version: '1.0.0',
                            source: 'workspace',
                            enabled: true,
                        }, loaded);
                        loadedCount++;
                    }
                }
            } catch (e: unknown) {
                logger.warn(COMPONENT, `Failed to load skill ${file}: ${(e as Error).message}`);
            }
        }
    }

    if (loadedCount > 0) {
        logger.info(COMPONENT, `Loaded ${loadedCount} user skill(s) from ~/.titan/skills/`);
    }
}

/**
 * Load a YAML skill definition.
 * Format:
 *   name: my_tool
 *   description: What it does
 *   parameters:
 *     myParam:
 *       type: string
 *       description: A parameter
 *       required: true
 *   script: |
 *     // JavaScript code. Use `args.myParam` for inputs.
 *     // Return a string result.
 *     return "Hello " + args.myParam;
 */
function loadYamlSkill(filePath: string): ToolHandler | null {
    const content = readFileSync(filePath, 'utf-8');

    // Simple YAML parser (no dependency needed for this basic format)
    const name = content.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    const scriptMatch = content.match(/^script:\s*\|\n([\s\S]+?)(?=\n\w|\n$|$)/m);
    const script = scriptMatch?.[1]?.replace(/^ {2}/gm, ''); // Remove YAML indent

    if (!name || !description || !script) {
        logger.debug(COMPONENT, `Skipping ${filePath}: missing name, description, or script`);
        return null;
    }

    // Parse parameters section
    const paramsSection = content.match(/^parameters:\n((?:\s{2}\w[\s\S]*?)(?=\nscript:|\n\w|\n$))/m);
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    if (paramsSection) {
        const paramLines = paramsSection[1].split('\n');
        let currentParam = '';
        for (const line of paramLines) {
            const paramMatch = line.match(/^\s{2}(\w+):\s*$/);
            if (paramMatch) {
                currentParam = paramMatch[1];
                properties[currentParam] = {};
                continue;
            }
            if (currentParam) {
                const typeMatch = line.match(/^\s{4}type:\s*(.+)$/);
                const descMatch = line.match(/^\s{4}description:\s*(.+)$/);
                const reqMatch = line.match(/^\s{4}required:\s*true$/);
                const defMatch = line.match(/^\s{4}default:\s*(.+)$/);
                if (typeMatch) properties[currentParam].type = typeMatch[1].trim();
                if (descMatch) properties[currentParam].description = descMatch[1].trim();
                if (reqMatch) required.push(currentParam);
                if (defMatch) properties[currentParam].default = defMatch[1].trim();
            }
        }
    }

    // Create the execute function from the script
    const handler: ToolHandler = {
        name,
        description,
        parameters: {
            type: 'object',
            properties,
            required: required.length > 0 ? required : undefined,
        },
        execute: async (args: Record<string, unknown>) => {
            try {
                // Run in a restricted VM context — no access to globalThis, process, eval, or Function
                const safeRequire = (mod: string) => {
                    // SECURITY: child_process, http, https removed — YAML skills must use builtin tools for shell/network
                    const allowed = ['fs', 'path', 'os', 'crypto', 'url', 'util'];
                    if (!allowed.includes(mod)) throw new Error(`Module "${mod}" not allowed in YAML skills`);
                    return require(mod); // eslint-disable-line @typescript-eslint/no-require-imports
                };
                const sandbox: Record<string, unknown> = {
                    args,
                    require: safeRequire,
                    console: { log: console.log },
                    JSON,
                    Math,
                    Date,
                    String,
                    Number,
                    Array,
                    Object,
                    RegExp,
                    Map,
                    Set,
                    Promise,
                    setTimeout,
                    Buffer,
                };
                // Wrap the user script in an async IIFE so `return` works and we can await it
                const wrapped = `(async function() { ${script} })()`;
                const result = await vm.runInNewContext(wrapped, sandbox, { timeout: 10000 });
                return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            } catch (err) {
                return `Error: ${(err as Error).message}`;
            }
        },
    };

    logger.debug(COMPONENT, `Loaded YAML skill: ${name} from ${filePath}`);
    return handler;
}
