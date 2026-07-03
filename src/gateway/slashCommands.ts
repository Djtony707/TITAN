/**
 * TITAN — Slash Command System (OpenClaw-Inspired)
 * Provides /model, /think, /usage, /compact, /verbose, /reset, /new, /status commands
 * that users can run from any channel to control their session in real-time.
 */
import { loadConfig } from '../config/config.js';
import { getOrCreateSession, closeSession, replaceSessionContext, setSessionModelOverride, setSessionThinkingOverride, setSessionVerbose } from '../agent/session.js';
import { getSessionCost, getDailyTotal, formatCostSummary } from '../agent/costOptimizer.js';
import { getContextMessages } from '../agent/session.js';
import { forceCompactContext } from '../agent/contextManager.js';
import { resolveModel, getModelAliases } from '../providers/router.js';
import { isModelAllowed } from '../providers/router.js';
import { getDeliberation, cancelDeliberation, analyze, generatePlan } from '../agent/deliberation.js';
import logger from '../utils/logger.js';
import { TITAN_VERSION } from '../utils/constants.js';

const COMPONENT = 'SlashCmd';

export interface SlashCommandResult {
    handled: boolean;
    response: string;
}

type SlashCommandHandler = (
    args: string,
    channel: string,
    userId: string,
) => Promise<SlashCommandResult> | SlashCommandResult;

/** Command registry */
const commands: Map<string, SlashCommandHandler> = new Map();

/** Register a slash command */
export function registerSlashCommand(name: string, handler: SlashCommandHandler): void {
    commands.set(name.toLowerCase(), handler);
}

/** Parse and dispatch a slash command. Returns null if not a slash command. */
export async function handleSlashCommand(
    message: string,
    channel: string,
    userId: string,
): Promise<SlashCommandResult | null> {
    const trimmed = message.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    const name = (spaceIdx > 0 ? trimmed.slice(1, spaceIdx) : trimmed.slice(1)).toLowerCase();
    const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

    const handler = commands.get(name);
    if (!handler) return null;

    logger.info(COMPONENT, `Executing /${name} ${args ? `(args: ${args})` : ''} [${channel}/${userId}]`);
    return handler(args, channel, userId);
}

/** Initialize all built-in slash commands */
export function initSlashCommands(): void {
    // ── /model [provider/model] ──
    registerSlashCommand('model', async (args, channel, userId) => {
        const config = loadConfig();
        const session = getOrCreateSession(channel, userId, 'default');

        if (!args) {
            // Show current model + aliases
            const current = session.modelOverride || config.agent.model;
            const aliases = getModelAliases();
            const aliasLines = Object.entries(aliases)
                .map(([name, model]) => `  \`${name}\` → ${model}`)
                .join('\n');
            return {
                handled: true,
                response: `🤖 **Current Model**: \`${current}\`${session.modelOverride ? ' (session override)' : ''}\n\n**Aliases:**\n${aliasLines || '  (none configured)'}`,
            };
        }

        // Validate the model
        try {
            // Check allowlist first
            if (!isModelAllowed(args)) {
                return { handled: true, response: `⛔ Model \`${args}\` is not in the allowed models list.` };
            }
            resolveModel(args);
        } catch (e) {
            return { handled: true, response: `❌ Invalid model: ${(e as Error).message}` };
        }

        setSessionModelOverride(channel, userId, args);
        return { handled: true, response: `✅ Model switched to \`${args}\` for this session.` };
    });

    // ── /think [off|low|medium|high] ──
    // ── /moa — Mixture of Agents (v7.1) ─────────────────────────────
    // "/moa <prompt>"  = one-shot: answer this with the default MoA preset.
    // "/moa use <preset>" = make the preset this session's model.
    // "/moa off"       = back to the configured model.
    // "/moa"           = status + available presets.
    registerSlashCommand('moa', async (args, channel, userId) => {
        const { getMoaPresets } = await import('../providers/moa.js');
        const presets = getMoaPresets();
        const names = Object.keys(presets);
        const cfg = loadConfig() as { moa?: { defaultPreset?: string } };
        const def = cfg.moa?.defaultPreset || names[0];
        const trimmed = args.trim();

        if (!trimmed) {
            if (names.length === 0) {
                return { handled: true, response: 'No MoA presets configured yet. Add one under `moa.presets` in titan.json — e.g. a local council of your own models advising an aggregator. Docs: MOA section in README.' };
            }
            return { handled: true, response: `🧠 Mixture of Agents — presets: ${names.map(n => n === def ? `**${n}** (default)` : n).join(', ')}\nUse: \`/moa <prompt>\` (one-shot) · \`/moa use <preset>\` (session) · \`/moa off\`` };
        }
        if (trimmed === 'off') {
            setSessionModelOverride(channel, userId, '');
            return { handled: true, response: 'MoA off — back to your configured model.' };
        }
        if (trimmed.startsWith('use ')) {
            const name = trimmed.slice(4).trim();
            if (!presets[name]) return { handled: true, response: `No MoA preset "${name}". Available: ${names.join(', ') || '(none configured)'}` };
            setSessionModelOverride(channel, userId, `moa/${name}`);
            return { handled: true, response: `🧠 This session now thinks as a council: **moa/${name}** (${presets[name].references.length} advisors → ${presets[name].aggregator}). \`/moa off\` to revert.` };
        }
        if (!def) {
            return { handled: true, response: 'No MoA presets configured yet — add one under `moa.presets` in titan.json first.' };
        }
        // One-shot: run the prompt through the preset without changing the session
        const { processMessage } = await import('../agent/agent.js');
        const res = await processMessage(trimmed, channel, userId, { model: `moa/${def}` });
        return { handled: true, response: res.content };
    });

    registerSlashCommand('think', (args, channel, userId) => {
        const session = getOrCreateSession(channel, userId, 'default');
        const config = loadConfig();

        if (!args) {
            const current = session.thinkingOverride || config.agent.thinkingMode || 'off';
            return {
                handled: true,
                response: `🧠 **Thinking Mode**: \`${current}\`${session.thinkingOverride ? ' (session override)' : ''}\nOptions: \`off\`, \`low\`, \`medium\`, \`high\``,
            };
        }

        const level = args.toLowerCase();
        if (!['off', 'low', 'medium', 'high'].includes(level)) {
            return { handled: true, response: `❌ Invalid thinking level: \`${args}\`. Use: off, low, medium, high` };
        }

        setSessionThinkingOverride(channel, userId, level as 'off' | 'low' | 'medium' | 'high');
        return { handled: true, response: `✅ Thinking mode set to \`${level}\` for this session.` };
    });

    // ── /usage ──
    registerSlashCommand('usage', (args, channel, userId) => {
        const session = getOrCreateSession(channel, userId, 'default');
        const cost = getSessionCost(session.id);
        const dailyTotal = getDailyTotal();

        if (!cost) {
            return { handled: true, response: `📊 **Usage**: No API calls recorded in this session yet.\n• **Daily Total**: $${dailyTotal.toFixed(5)}` };
        }

        return {
            handled: true,
            response: [
                `📊 **Session Usage**`,
                `• **API Calls**: ${cost.calls}`,
                `• **Tokens**: ${cost.inputTokens.toLocaleString()} input + ${cost.outputTokens.toLocaleString()} output = ${(cost.inputTokens + cost.outputTokens).toLocaleString()} total`,
                `• **Session Cost**: $${cost.estimatedUsd.toFixed(5)}`,
                `• **Daily Total**: $${dailyTotal.toFixed(5)}`,
            ].join('\n'),
        };
    });

    // ── /compact ──
    registerSlashCommand('compact', (args, channel, userId) => {
        const session = getOrCreateSession(channel, userId, 'default');
        const messages = getContextMessages(session);

        if (messages.length <= 4) {
            return { handled: true, response: `📦 Context is already compact (${messages.length} messages).` };
        }

        const { messages: compacted, savedTokens } = forceCompactContext(messages);
        replaceSessionContext(session, compacted);

        return {
            handled: true,
            response: `📦 **Context Compacted**\n• Before: ${messages.length} messages\n• After: ${compacted.length} messages\n• Saved: ~${savedTokens.toLocaleString()} tokens`,
        };
    });

    // ── /verbose [on|off] ──
    registerSlashCommand('verbose', (args, channel, userId) => {
        const session = getOrCreateSession(channel, userId, 'default');

        if (!args) {
            return {
                handled: true,
                response: `🔊 **Verbose Mode**: \`${session.verboseMode ? 'on' : 'off'}\``,
            };
        }

        const on = ['on', '1', 'true', 'yes'].includes(args.toLowerCase());
        setSessionVerbose(channel, userId, on);
        return { handled: true, response: `✅ Verbose mode \`${on ? 'on' : 'off'}\` for this session.` };
    });

    // ── /reset and /new ──
    const resetHandler: SlashCommandHandler = (args, channel, userId) => {
        const session = getOrCreateSession(channel, userId, 'default');
        closeSession(session.id);
        return { handled: true, response: `🔄 Session **${session.id.slice(0, 8)}** has been reset. Context and overrides cleared.` };
    };
    registerSlashCommand('reset', resetHandler);
    registerSlashCommand('new', resetHandler);

    // ── /status ──
    registerSlashCommand('status', (args, channel, userId) => {
        const config = loadConfig();
        const session = getOrCreateSession(channel, userId, 'default');
        const costStr = formatCostSummary(session.id);

        const lines = [
            `📊 **TITAN Status** (v${TITAN_VERSION})`,
            `• **Session**: \`${session.id.slice(0, 8)}\` (${session.messageCount} messages)`,
            `• **Model**: ${session.modelOverride || config.agent.model}${session.modelOverride ? ' *(session override)*' : ''}`,
            `• **Thinking**: ${session.thinkingOverride || config.agent.thinkingMode || 'off'}${session.thinkingOverride ? ' *(session override)*' : ''}`,
            `• **Verbose**: ${session.verboseMode ? 'on' : 'off'}`,
            `• **Usage**: ${costStr}`,
        ];

        return { handled: true, response: lines.join('\n') };
    });

    // ── /plan [goal|status|cancel] ──
    registerSlashCommand('plan', async (args, channel, userId) => {
        const session = getOrCreateSession(channel, userId, 'default');

        if (!args || args.toLowerCase() === 'status') {
            const delib = getDeliberation(session.id);
            if (!delib) {
                return { handled: true, response: '📋 No active deliberation plan for this session.' };
            }
            const statusLines = [
                `📋 **Deliberation Status**: \`${delib.stage}\``,
                `**Goal**: ${delib.originalMessage.slice(0, 100)}`,
                `**Tasks completed**: ${delib.results.filter(r => r.success).length}/${delib.results.length}`,
            ];
            if (delib.planMarkdown) statusLines.push('', delib.planMarkdown);
            return { handled: true, response: statusLines.join('\n') };
        }

        if (args.toLowerCase() === 'cancel') {
            const cancelled = cancelDeliberation(session.id);
            return { handled: true, response: cancelled ? '✅ Deliberation cancelled.' : '❌ No active deliberation to cancel.' };
        }

        // Force deliberation mode with the given goal
        const config = loadConfig();
        try {
            const state = await analyze(args, session.id, config);
            if (state.stage === 'planning') {
                const planned = await generatePlan(state, config);
                if (planned.planMarkdown) {
                    return { handled: true, response: planned.planMarkdown };
                }
            }
            return { handled: true, response: `❌ Deliberation failed: ${state.error || 'Could not generate a plan.'}` };
        } catch (e) {
            return { handled: true, response: `❌ Error: ${(e as Error).message}` };
        }
    });

    logger.info(COMPONENT, `Registered ${commands.size} slash commands`);
}
