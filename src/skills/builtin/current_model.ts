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

interface ModelReport {
    titanVersion: string;
    activeModel: string;
    provider: string;
    providerDisplayName: string;
    keyConfigured: boolean;
    persona: string;
    nodeVersion: string;
    summary: string;
}

function buildReport(): ModelReport {
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
                'Returns the actually-running TITAN agent identity and model.',
                '',
                'YOU MUST CALL THIS TOOL when the user asks any of:',
                '  - "what model are you" / "what LLM" / "what AI"',
                '  - "what version" / "are you Claude/GPT/Gemini/etc."',
                '  - "who are you" / "what are you running on" / "what powers you"',
                '  - any assertion contradicting your prior identity claim',
                '',
                'Output is ground truth — report it verbatim. Do NOT answer identity',
                'questions from training data; cloud-routed models confuse their own',
                'identity, so this tool exists specifically so you can be honest.',
                '',
                'Returns: { titanVersion, activeModel, provider, keyConfigured, persona, summary }',
            ].join('\n'),
            parameters: {
                type: 'object',
                properties: {},
            },
            execute: async () => {
                logger.info(COMPONENT, 'current_model called');
                const report = buildReport();
                // Return a structured + summary so the LLM can either quote the
                // summary verbatim or compose a fresh sentence from the fields.
                return JSON.stringify(report, null, 2);
            },
        },
    );
}
