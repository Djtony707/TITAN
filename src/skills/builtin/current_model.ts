/**
 * TITAN — Current Model Skill (Built-in)
 *
 * Returns the actually-running model + provider + version + key state.
 *
 * WHY THIS EXISTS:
 * Cloud-routed open models (e.g. ollama/deepseek-v4-flash:cloud) often
 * answer "what model are you?" with their training-time identity (e.g.
 * "I'm Claude 3.5 Sonnet"), even when the system prompt explicitly says
 * "you are TITAN powered by deepseek-v4-flash". The model's strongly-
 * trained self-identity overrides system-prompt prose.
 *
 * The fix is to make identity questions tool-grounded instead of
 * prompt-grounded: when the user asks what TITAN is running on, the
 * agent MUST call this tool and report what it returns verbatim. Anything
 * else is hallucinated.
 *
 * The TOOL_USE_CORE block in systemPromptParts.ts directs the LLM to
 * use this tool for any identity/model/llm/version question.
 */
import { registerSkill } from '../registry.js';
import { loadConfig } from '../../config/config.js';
import { TITAN_VERSION } from '../../utils/constants.js';
import { getProvider } from '../../providers/router.js';
import { LLMProvider } from '../../providers/base.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'CurrentModel';

export interface ModelReport {
    titanVersion: string;
    activeModel: string;
    provider: string;
    providerDisplayName: string;
    keyConfigured: boolean;
    persona: string;
    nodeVersion: string;
    summary: string;
}

export function buildCurrentModelReport(): ModelReport {
    const config = loadConfig();
    const activeModel = config.agent.model || 'unknown';
    const persona = config.agent.persona || 'default';

    // Resolve the provider so we can report its display name and key state.
    // Uses the public getProvider() lookup + isConfigured() introduced in v5.6.4.
    let providerName = 'unknown';
    let providerDisplayName = 'Unknown';
    let keyConfigured = false;
    try {
        const parsed = LLMProvider.parseModelId(activeModel);
        providerName = parsed.provider;
        const provider = getProvider(providerName);
        if (provider) {
            providerDisplayName = provider.displayName;
            keyConfigured = provider.isConfigured();
        } else {
            providerDisplayName = providerName.charAt(0).toUpperCase() + providerName.slice(1);
        }
    } catch {
        // Fall through with unknown values.
    }

    const summary = `I am TITAN ${TITAN_VERSION} (The Intelligent Task Automation Network), built by Tony Elliott. I'm currently running on ${activeModel} via the ${providerDisplayName} provider${keyConfigured ? '' : ' (no API key configured)'}, with the "${persona}" persona active.`;

    return {
        titanVersion: TITAN_VERSION,
        activeModel,
        provider: providerName,
        providerDisplayName,
        keyConfigured,
        persona,
        nodeVersion: process.version,
        summary,
    };
}

export function registerCurrentModelSkill(): void {
    registerSkill(
        {
            name: 'current_model',
            description: 'Returns the actually-running TITAN model and version',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'current_model',
            description: [
                'Returns the actually-running TITAN agent identity and model. Ground truth from loaded config + provider registry — NOT from the LLM\'s training data.',
                '',
                'YOU MUST CALL THIS TOOL when the user asks any of:',
                '  - "what model are you" / "what LLM" / "what AI"',
                '  - "what version" / "are you Claude/GPT/Gemini/etc."',
                '  - "who are you" / "what are you running on" / "what powers you"',
                '  - any assertion contradicting your prior identity claim ("no you\'re not")',
                '',
                'Cloud-routed open models often answer identity questions from their training-time self-identity ("I\'m Claude Sonnet"), even when the system prompt says otherwise. This tool exists specifically so you can be honest. Report what it returns verbatim — do not paraphrase the active model name.',
                '',
                'DO NOT USE FOR:',
                '  - Switching models → use switch_model.',
                '  - Listing available models → use list_models or /api/models.',
                '  - Switching personas → use switch_persona.',
                '',
                'Parameters: none.',
                '',
                'Returns: {',
                '  titanVersion: string,        // e.g. "5.7.0"',
                '  activeModel: string,         // e.g. "ollama/deepseek-v4-flash:cloud"',
                '  provider: string,            // e.g. "ollama"',
                '  providerDisplayName: string, // e.g. "Ollama (Local)"',
                '  keyConfigured: boolean,      // true if provider has an API key configured',
                '  persona: string,             // active persona id',
                '  nodeVersion: string,         // host node.js version',
                '  summary: string              // pre-composed sentence — quote it verbatim',
                '}',
                '',
                'Errors: cannot error in normal operation. Falls back to "unknown" fields if the provider registry isn\'t initialized yet.',
            ].join('\n'),
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                logger.info(COMPONENT, 'current_model called');
                const report = buildCurrentModelReport();
                // Return a structured + summary so the LLM can either quote the
                // summary verbatim or compose a fresh sentence from the fields.
                return JSON.stringify(report, null, 2);
            },
        },
    );
}
