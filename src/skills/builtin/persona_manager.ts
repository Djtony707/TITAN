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
        description: `List all available TITAN persona profiles (name, id, description, division, active-or-not). Personas determine how TITAN talks and which sub-agent style it adopts; there are 43 bundled (default, autonomous, debugger, code-reviewer, security-engineer, doubter, source-citer, etc.) plus any user-authored ones in ~/.titan/personas/.

USE WHEN: "what personas do you have" / "show me your modes" / "what styles can you switch to" / "list personalities" — or proactively before switch_persona if the user is uncertain which to pick.

DO NOT USE FOR:
- Inspecting a single persona's content → use get_persona.
- Adding a new persona → drop a .md file in ~/.titan/personas/, with frontmatter { name, id, description, division }.

Parameters: none.

Returns: a numbered list "Available personas (43): * default — Friendly all-purpose ... Active: default". The asterisk marks the currently active persona.

Errors: cannot error.`,
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
        description: `Switch TITAN's active persona, changing how it talks and which sub-agent style it adopts. Takes effect on the NEXT message — the current reply uses the prior persona. Persisted in config; survives restarts.

USE WHEN: "change your personality" / "be more concise" / "act as X" / "switch to developer mode" / "be more formal/casual" / "use the doubter persona" — anything that's a request to shift TITAN's communication style or role. Combine with list_personas if the user named a style but not an id.

DO NOT USE FOR:
- One-off tone change for a single reply → just adjust your reply tone, don't switch the global persona.
- Inspecting what a persona is before switching → use get_persona.
- Picking a model → use switch_model (orthogonal).

Parameters:
- persona (string, required) — exact persona id from list_personas (e.g., "doubter", "code-reviewer", "default").

Returns: "Switched to persona: <id>. Changes take effect on the next message."

Errors:
- "Persona <id> not found. Available: ..." — id was wrong. Tell the user what's available and ask which they meant.`,
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
        description: `Show the full markdown definition of a specific persona — name, id, division, description, and the complete body content (the persona's system-prompt overlay).

USE WHEN: "tell me about the X persona" / "what does the developer mode do" / "describe that personality" / "what would the doubter say" — also use before switch_persona if the user wants to know what they're switching into.

DO NOT USE FOR:
- Listing all personas → use list_personas.
- Activating a persona → use switch_persona.

Parameters:
- persona (string, required) — exact id from list_personas.

Returns: a markdown document with the persona's header (name, id, division, description) followed by the full overlay content.

Errors:
- "Persona <id> not found." — verify id via list_personas.`,
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
