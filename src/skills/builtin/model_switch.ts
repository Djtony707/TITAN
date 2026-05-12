/**
 * TITAN — Model Switch Tool
 * Lets TITAN (or the user) swap the active LLM mid-session.
 * Like telling JARVIS to "switch to a faster mode" or "use the smarter model for this".
 */
import { z } from 'zod';
import { registerSkill } from '../registry.js';
import { loadConfig, updateConfig } from '../../config/config.js';

const SwitchModelSchema = z.object({
    model: z.string().describe('The model identifier to switch to, e.g. openai/gpt-4o or anthropic/claude-sonnet-4-20250514'),
    reason: z.string().optional().describe('Why you are switching models'),
});

export function initModelSwitchTool(): void {
    registerSkill({
        name: 'switch_model',
        description: 'Use this when the user says "switch to a faster model", "use the smart model", "switch to qwen", "use Claude for this", "go local", or any request to change which AI is active. Known aliases: fast=devstral-small-2 (quick tasks), smart/cloud=qwen3.5:397b-cloud (complex reasoning), local=qwen3.5:35b (offline/GPU). Also use this proactively when a task clearly needs a different capability tier.',
        version: '1.0.0',
        source: 'bundled',
        enabled: true,
    }, {
        name: 'switch_model',
        description: `Switch which LLM TITAN routes to mid-session. Persisted in config — survives restarts. Use full provider/model IDs (e.g. "ollama/qwen3.5:cloud", "anthropic/claude-opus-4-0") OR the configured aliases ("fast", "smart", "cloud", "local").

USE WHEN: "switch to a faster model" / "use the smart model" / "switch to qwen" / "use Claude" / "go local" — or proactively when the task obviously needs a different tier (smart for deep analysis, fast for simple lookups).

DO NOT USE FOR:
- Looking up what models are available → use /api/models or list_models.
- Identity questions ("what model are you running?") → use current_model (read-only).
- One-off task with a different model → just route the single call; don't permanently switch.

Parameters:
- model (string, required) — full provider/model id ("ollama/qwen3.5:cloud", "anthropic/claude-opus-4-0") OR alias ("fast", "smart", "cloud", "local").
- reason (string, optional) — why; helpful for audit logs.

Returns: "Switched to model: <id>". Persisted in titan.json under agent.model.

Errors:
- "Provider X has no API key configured" — switching to a provider without a key works (it gets stored), but the next request will fail-fast until a key is set. Tell the user to configure the key first.
- "Unknown alias" — aliases are configured in titan.json under agent.modelAliases; check there.`,
        parameters: {
            type: 'object',
            properties: {
                model: {
                    type: 'string',
                    description: 'Model identifier to switch to (e.g. ollama/devstral-small-2, ollama/qwen3.5:35b, anthropic/claude-opus-4-0)',
                },
                reason: {
                    type: 'string',
                    description: 'Why you are switching models (optional)',
                },
            },
            required: ['model'],
        },
        execute: async (args) => {
            const { model, reason } = SwitchModelSchema.parse(args);
            updateConfig({ agent: { ...loadConfig().agent, model } });
            return `✅ Switched to model: **${model}**${reason ? `\nReason: ${reason}` : ''}`;
        },
    });
}
