/**
 * TITAN — Persona Manager Skill
 * Tools for listing, switching, and inspecting personas.
 */
import { registerSkill } from '../registry.js';
import { loadConfig, updateConfig } from '../../config/config.js';
import { listPersonas, getPersona, invalidatePersonaCache } from '../../personas/manager.js';

export function registerPersonaManagerSkill(): void {
    registerSkill({
        name: 'list_personas',
        description: 'Use this when asked "what personalities do you have?", "show me your personas", "what modes can you be in?", or before switching to help the user choose.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'list_personas',
        description: 'List all available TITAN personality profiles (personas). Use when asked "what personalities do you have?", "show me your personas", "what modes can you switch to?", or to help the user pick one before switching.',
        parameters: { type: 'object', properties: {}, required: [] },
        execute: async () => {
            const personas = listPersonas();
            if (personas.length === 0) return 'No personas found.';
            const config = loadConfig();
            const active = config.agent.persona || 'default';
            const lines = personas.map(p =>
                `${p.id === active ? '* ' : '  '}**${p.name}** (${p.id}) — ${p.description} [${p.division}]`
            );
            return `Available personas (${personas.length}):\n${lines.join('\n')}\n\nActive: ${active}`;
        },
    });

    registerSkill({
        name: 'switch_persona',
        description: 'Use this when the user says "change your personality", "be more concise", "act as X", "switch to work mode", "be more casual", "switch to developer mode", "change how you talk", or any request to shift TITAN\'s communication style or role.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'switch_persona',
        description: 'Switch TITAN\'s personality and communication style. Use this when asked to "change your personality", "be more concise", "act as X", "switch to work mode", "be more casual", "talk like a developer", "be more formal", or any request to shift how TITAN communicates. Use list_personas first if you\'re unsure which persona fits.',
        parameters: {
            type: 'object',
            properties: {
                persona: { type: 'string', description: 'Persona ID to switch to (use list_personas to see available options)' },
            },
            required: ['persona'],
        },
        execute: async (args) => {
            const id = args.persona as string;
            if (id !== 'default') {
                const persona = getPersona(id);
                if (!persona) {
                    const available = listPersonas().map(p => p.id).join(', ');
                    return `Persona "${id}" not found. Available: ${available}`;
                }
            }
            const config = loadConfig();
            updateConfig({ agent: { ...config.agent, persona: id } });
            invalidatePersonaCache();
            return `Switched to persona: **${id}**. Changes take effect on the next message.`;
        },
    });

    registerSkill({
        name: 'get_persona',
        description: 'Use this when asked "tell me about the X persona", "what does the developer persona do?", or "describe that mode" to show the full personality definition.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'get_persona',
        description: 'Show the full definition and personality traits of a specific persona. Use when asked "tell me about the X persona", "what does the developer mode do?", "describe that personality", or before switching to help explain what the persona is like.',
        parameters: {
            type: 'object',
            properties: {
                persona: { type: 'string', description: 'Persona ID to inspect (use list_personas to see IDs)' },
            },
            required: ['persona'],
        },
        execute: async (args) => {
            const id = args.persona as string;
            const persona = getPersona(id);
            if (!persona) return `Persona "${id}" not found.`;
            return `# ${persona.name}\n**ID:** ${persona.id}\n**Division:** ${persona.division}\n**Description:** ${persona.description}\n\n${persona.content}`;
        },
    });
}
