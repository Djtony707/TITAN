/**
 * TITAN — Webhook Skill (Built-in)
 * Create and manage HTTP webhook endpoints with persistence.
 */
import { registerSkill } from '../registry.js';
import { getDb, rememberFact, searchMemories } from '../../memory/memory.js';
import { v4 as uuid } from 'uuid';
import logger from '../../utils/logger.js';

const COMPONENT = 'Webhook';
const WEBHOOK_CATEGORY = 'webhook';

/** In-memory webhook registry */
const activeWebhooks: Map<string, {
    id: string;
    path: string;
    name: string;
    method: string;
    handler: string;
}> = new Map();

export function getActiveWebhooks() {
    return activeWebhooks;
}

/**
 * Initialize persistent webhooks on startup.
 * Load all webhooks from database into the activeWebhooks Map.
 */
export async function initPersistentWebhooks(): Promise<void> {
    try {
        const webhooks = await searchMemories(WEBHOOK_CATEGORY);
        let loaded = 0;
        for (const entry of webhooks) {
            try {
                const webhook = JSON.parse(entry.value) as {
                    id: string;
                    path: string;
                    name: string;
                    method: string;
                    handler: string;
                };
                activeWebhooks.set(webhook.id, webhook);
                loaded++;
            } catch {
                logger.warn(COMPONENT, `Skipped corrupted webhook entry: ${entry.key}`);
            }
        }
        if (loaded > 0) {
            logger.info(COMPONENT, `Loaded ${loaded} persisted webhook(s) from database`);
        }
    } catch (e) {
        logger.warn(COMPONENT, `Failed to initialize persistent webhooks: ${(e as Error).message}`);
    }
}

export function registerWebhookSkill(): void {
    registerSkill(
        { name: 'webhook', description: 'Create, list, or delete HTTP webhook endpoints. USE THIS WHEN Tony says: "create a webhook", "set up a webhook endpoint", "trigger webhook", "call endpoint X", "send data to URL", "register a webhook for X", "delete webhook X". WORKFLOW: action=create to register a new endpoint, action=list to see active webhooks, action=delete to remove one.', version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'webhook',
            description: 'Creates, lists, or deletes HTTP webhook endpoints that trigger actions when called. USE THIS WHEN Tony says: "create a webhook", "set up a webhook endpoint", "trigger webhook", "call endpoint X", "send data to URL", "register a webhook for X", "delete webhook X". WORKFLOW: action=create with name, path, method, and handler command to register — action=list to see all active webhooks — action=delete with webhookId to remove. RULES: Webhooks persist across restarts.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['create', 'list', 'delete'], description: 'Action' },
                    name: { type: 'string', description: 'Webhook name' },
                    path: { type: 'string', description: 'URL path (e.g., /my-hook)' },
                    method: { type: 'string', description: 'HTTP method (GET/POST, default: POST)' },
                    handler: { type: 'string', description: 'Command to run when webhook is triggered' },
                    webhookId: { type: 'string', description: 'Webhook ID (for delete)' },
                },
                required: ['action'],
            },
            execute: async (args) => {
                const action = args.action as string;

                switch (action) {
                    case 'create': {
                        const id = uuid();
                        const name = (args.name as string) || `webhook-${id.slice(0, 8)}`;
                        const path = (args.path as string) || `/webhook/${id.slice(0, 8)}`;
                        const method = (args.method as string) || 'POST';
                        const handler = (args.handler as string) || '';
                        const webhook = { id, path, name, method, handler };
                        activeWebhooks.set(id, webhook);
                        // Persist to database
                        try {
                            rememberFact(WEBHOOK_CATEGORY, id, JSON.stringify(webhook));
                        } catch (e) {
                            logger.warn(COMPONENT, `Failed to persist webhook to database: ${(e as Error).message}`);
                        }
                        logger.info(COMPONENT, `Created webhook: ${name} at ${path}`);
                        return `Created webhook "${name}"\n  ID: ${id}\n  Path: ${path}\n  Method: ${method}\n  Handler: ${handler}`;
                    }
                    case 'list': {
                        if (activeWebhooks.size === 0) return 'No active webhooks.';
                        return Array.from(activeWebhooks.values())
                            .map((w) => `• ${w.name}\n  ID: ${w.id}\n  ${w.method} ${w.path}\n  Handler: ${w.handler}`)
                            .join('\n\n');
                    }
                    case 'delete': {
                        const wId = args.webhookId as string;
                        if (!wId) return 'Error: webhookId is required';
                        activeWebhooks.delete(wId);
                        // Remove from database
                        try {
                            const db = getDb();
                            const idx = db.memories.findIndex((m) => m.category === WEBHOOK_CATEGORY && m.key === wId);
                            if (idx >= 0) {
                                db.memories.splice(idx, 1);
                            }
                        } catch (e) {
                            logger.warn(COMPONENT, `Failed to delete webhook from database: ${(e as Error).message}`);
                        }
                        return `Deleted webhook: ${wId}`;
                    }
                    default:
                        return `Unknown action: ${action}`;
                }
            },
        },
    );
}
