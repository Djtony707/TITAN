/**
 * TITAN — Event Triggers Skill (Built-in)
 * Event-driven reactive automation: "when X happens, do Y".
 * Manages triggers that fire actions in response to file changes, webhooks,
 * system events, email arrivals, and custom events.
 * Triggers are persisted to ~/.titan/triggers/ as JSON files.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, watch, type FSWatcher } from 'fs';
import { join, resolve, normalize } from 'path';
import { homedir } from 'os';
import { registerSkill } from '../registry.js';
import { TITAN_HOME } from '../../utils/constants.js';
import { randomUUID } from 'crypto';
import logger from '../../utils/logger.js';

const COMPONENT = 'EventTriggers';
const TRIGGERS_DIR = join(TITAN_HOME, 'triggers');
const LOG_PATH = join(TRIGGERS_DIR, '_fire_log.json');
const MAX_LOG_ENTRIES = 50;

// ─── Types ──────────────────────────────────────────────────────

export type TriggerEvent = 'file_change' | 'webhook' | 'schedule' | 'system' | 'email' | 'custom';

export interface TriggerCondition {
    /** file_change: path to watch */
    path?: string;
    /** file_change: glob pattern filter */
    pattern?: string;
    /** webhook: endpoint path */
    endpoint?: string;
    /** schedule: cron expression */
    cron?: string;
    /** system: event name (e.g., "startup", "shutdown", "error") */
    event?: string;
    /** email: filter criteria */
    from?: string;
    subject?: string;
    /** custom: arbitrary key-value for custom matching */
    [key: string]: unknown;
}

export interface TriggerAction {
    /** Tool to invoke when trigger fires */
    tool?: string;
    /** Parameters to pass to the tool */
    params?: Record<string, unknown>;
    /** Or: a message prompt to send to the agent */
    message?: string;
}

export interface Trigger {
    id: string;
    name: string;
    event: TriggerEvent;
    condition: TriggerCondition;
    action: TriggerAction;
    enabled: boolean;
    created_at: string;
    last_fired?: string;
    fire_count: number;
}

export interface FireLogEntry {
    trigger_id: string;
    trigger_name: string;
    event: TriggerEvent;
    fired_at: string;
    result: string;
    simulated: boolean;
}

// ─── Active watchers (for file_change triggers) ─────────────────

const activeWatchers = new Map<string, FSWatcher>();

// ─── Persistence helpers ─────────────────────────────────────────

function ensureTriggersDir(): void {
    if (!existsSync(TRIGGERS_DIR)) {
        mkdirSync(TRIGGERS_DIR, { recursive: true });
    }
}

function triggerFilePath(id: string): string {
    // Sanitize ID to prevent path traversal
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
    return join(TRIGGERS_DIR, `${safeId}.json`);
}

export function saveTrigger(trigger: Trigger): void {
    ensureTriggersDir();
    writeFileSync(triggerFilePath(trigger.id), JSON.stringify(trigger, null, 2));
}

export function loadTrigger(id: string): Trigger | null {
    const path = triggerFilePath(id);
    if (!existsSync(path)) return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8')) as Trigger;
    } catch {
        return null;
    }
}

export function loadAllTriggers(): Trigger[] {
    ensureTriggersDir();
    const files = readdirSync(TRIGGERS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    const triggers: Trigger[] = [];
    for (const file of files) {
        try {
            const data = JSON.parse(readFileSync(join(TRIGGERS_DIR, file), 'utf-8')) as Trigger;
            triggers.push(data);
        } catch {
            logger.warn(COMPONENT, `Skipped corrupted trigger file: ${file}`);
        }
    }
    return triggers;
}

export function deleteTriggerFile(id: string): boolean {
    const path = triggerFilePath(id);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    // Clean up any active watcher
    const watcher = activeWatchers.get(id);
    if (watcher) {
        watcher.close();
        activeWatchers.delete(id);
    }
    return true;
}

function findTriggerByName(name: string): Trigger | null {
    const triggers = loadAllTriggers();
    return triggers.find(t => t.name === name) || null;
}

// ─── Fire log ────────────────────────────────────────────────────

export function loadFireLog(): FireLogEntry[] {
    if (!existsSync(LOG_PATH)) return [];
    try {
        return JSON.parse(readFileSync(LOG_PATH, 'utf-8')) as FireLogEntry[];
    } catch {
        return [];
    }
}

export function appendFireLog(entry: FireLogEntry): void {
    ensureTriggersDir();
    const log = loadFireLog();
    log.push(entry);
    // Keep only the last MAX_LOG_ENTRIES
    const trimmed = log.slice(-MAX_LOG_ENTRIES);
    writeFileSync(LOG_PATH, JSON.stringify(trimmed, null, 2));
}

// ─── Fire a trigger (execute its action) ─────────────────────────

export async function fireTrigger(trigger: Trigger, simulated: boolean = false): Promise<string> {
    const now = new Date().toISOString();
    let result: string;

    try {
        if (trigger.action.tool) {
            // In real execution, the gateway would route this to the tool runner.
            // For now, return a description of what would happen.
            result = `Action: invoke tool "${trigger.action.tool}" with params ${JSON.stringify(trigger.action.params || {})}`;
        } else if (trigger.action.message) {
            result = `Action: send message to agent: "${trigger.action.message}"`;
        } else {
            result = 'Error: trigger has no action configured (need tool or message)';
        }

        // Update trigger state (only for non-simulated fires, or simulated for logging)
        if (!simulated) {
            trigger.last_fired = now;
            trigger.fire_count += 1;
            saveTrigger(trigger);
        }

        // Log the fire event
        appendFireLog({
            trigger_id: trigger.id,
            trigger_name: trigger.name,
            event: trigger.event,
            fired_at: now,
            result,
            simulated,
        });

        logger.info(COMPONENT, `Trigger "${trigger.name}" fired${simulated ? ' (simulated)' : ''}: ${result}`);
        return result;
    } catch (err) {
        result = `Error firing trigger: ${(err as Error).message}`;
        appendFireLog({
            trigger_id: trigger.id,
            trigger_name: trigger.name,
            event: trigger.event,
            fired_at: now,
            result,
            simulated,
        });
        logger.error(COMPONENT, result);
        return result;
    }
}

// ─── Event dispatch (called by gateway or external systems) ──────

/**
 * Dispatch an event to all matching triggers.
 * Returns the number of triggers that fired.
 */
export async function dispatchEvent(event: TriggerEvent, _payload: Record<string, unknown> = {}): Promise<number> {
    const triggers = loadAllTriggers().filter(t => t.enabled && t.event === event);
    let fired = 0;

    for (const trigger of triggers) {
        await fireTrigger(trigger);
        fired++;
    }

    return fired;
}

// ─── Initialize file watchers for file_change triggers ──────────

export function initFileWatchers(): void {
    const triggers = loadAllTriggers().filter(t => t.enabled && t.event === 'file_change');
    for (const trigger of triggers) {
        startFileWatcher(trigger);
    }
    if (triggers.length > 0) {
        logger.info(COMPONENT, `Started ${triggers.length} file watcher(s)`);
    }
}

/** Security: validate that a watch path is within allowed directories */
function isAllowedWatchPath(watchPath: string): boolean {
    const normalized = normalize(resolve(watchPath));
    const home = homedir();
    // Only allow watching under home directory or /tmp
    if (!normalized.startsWith(home) && !normalized.startsWith('/tmp')) return false;
    // Block sensitive directories
    const lowerPath = normalized.toLowerCase();
    const blocked = ['.ssh', '.gnupg', '.env', 'credentials', '.aws', '.gcloud', '.kube'];
    for (const b of blocked) {
        if (lowerPath.includes(`/${b}`) || lowerPath.endsWith(`/${b}`)) return false;
    }
    return true;
}

function startFileWatcher(trigger: Trigger): void {
    const watchPath = trigger.condition.path;
    if (!watchPath || !existsSync(watchPath)) {
        logger.warn(COMPONENT, `Cannot watch path for trigger "${trigger.name}" — path does not exist`);
        return;
    }

    // Security: confine file watchers to allowed directories
    if (!isAllowedWatchPath(watchPath)) {
        logger.warn(COMPONENT, `Blocked file watcher for trigger "${trigger.name}" — path outside allowed directories`);
        return;
    }

    try {
        const watcher = watch(watchPath, { recursive: true }, (eventType, filename) => {
            const pattern = trigger.condition.pattern;
            if (pattern && filename && !matchGlob(filename, pattern)) return;

            logger.info(COMPONENT, `File ${eventType}: ${filename} — firing trigger "${trigger.name}"`);
            fireTrigger(trigger).catch(err => {
                logger.error(COMPONENT, `Error firing trigger "${trigger.name}": ${(err as Error).message}`);
            });
        });
        activeWatchers.set(trigger.id, watcher);
    } catch (err) {
        logger.error(COMPONENT, `Failed to start file watcher for "${trigger.name}": ${(err as Error).message}`);
    }
}

/** Simple glob matching (supports * and ?) with ReDoS protection */
function matchGlob(filename: string, pattern: string): boolean {
    // Security: limit pattern length to prevent ReDoS
    if (pattern.length > 200) return false;
    // Security: limit consecutive wildcards (collapse ** into *)
    const safePattern = pattern.replace(/\*{2,}/g, '*');
    const regex = new RegExp(
        '^' + safePattern.replace(/\./g, '\\.').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$',
    );
    // Limit filename length for regex test
    const testName = filename.length > 1000 ? filename.slice(0, 1000) : filename;
    return regex.test(testName);
}

// ─── Stop all watchers (for shutdown) ────────────────────────────

export function stopAllWatchers(): void {
    for (const watcher of activeWatchers.values()) {
        watcher.close();
    }
    activeWatchers.clear();
    logger.info(COMPONENT, 'Stopped all file watchers');
}

// ─── Validation ─────────────────────────────────────────────────

const VALID_EVENTS: TriggerEvent[] = ['file_change', 'webhook', 'schedule', 'system', 'email', 'custom'];

function validateTriggerInput(args: Record<string, unknown>): string | null {
    const { name, event, condition, action } = args;

    if (!name || typeof name !== 'string') return 'Error: "name" is required and must be a string';
    if (!event || !VALID_EVENTS.includes(event as TriggerEvent)) {
        return `Error: "event" must be one of: ${VALID_EVENTS.join(', ')}`;
    }
    if (!condition || typeof condition !== 'object') return 'Error: "condition" is required and must be an object';
    if (!action || typeof action !== 'object') return 'Error: "action" is required and must be an object';

    const act = action as TriggerAction;
    if (!act.tool && !act.message) return 'Error: "action" must contain either "tool" or "message"';

    // Event-specific validation
    if (event === 'file_change') {
        const cond = condition as TriggerCondition;
        if (!cond.path) return 'Error: file_change triggers require "condition.path"';
        // Security: validate watch path is within allowed directories
        if (!isAllowedWatchPath(cond.path)) {
            return 'Error: file_change path must be within your home directory or /tmp, and cannot target sensitive directories (.ssh, .gnupg, etc.)';
        }
    }
    if (event === 'webhook') {
        const cond = condition as TriggerCondition;
        if (!cond.endpoint) return 'Error: webhook triggers require "condition.endpoint"';
    }

    // Check for duplicate names
    const existing = findTriggerByName(name as string);
    if (existing) return `Error: a trigger named "${name}" already exists (ID: ${existing.id})`;

    return null;
}

// ─── Skill Registration ─────────────────────────────────────────

export function registerEventTriggersSkill(): void {
    const skillMeta = {
        name: 'event_triggers',
        description: 'Event-driven reactive automation — "when X happens, do Y". Create triggers that fire actions in response to file changes, webhooks, system events, emails, or custom events. USE THIS WHEN Tony says: "when this file changes do X", "set up a trigger", "react to webhook", "automate when X happens", "create an event trigger".',
        version: '1.0.0',
        source: 'bundled' as const,
        enabled: true,
    };

    // Tool 1: trigger_create
    registerSkill(skillMeta, {
        name: 'trigger_create',
        description: 'Create an event trigger — when an event occurs, an action fires automatically. USE THIS WHEN Tony says: "when this file changes, do X", "set up a trigger for webhooks", "react to system events". Events: file_change, webhook, schedule, system, email, custom. Action: invoke a tool or send a message to the agent.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Human-readable trigger name' },
                event: {
                    type: 'string',
                    enum: ['file_change', 'webhook', 'schedule', 'system', 'email', 'custom'],
                    description: 'Event type that activates this trigger',
                },
                condition: {
                    type: 'object',
                    description: 'Event-specific config. file_change: {path, pattern}. webhook: {endpoint}. schedule: {cron}. system: {event}. email: {from, subject}. custom: any key-value pairs.',
                },
                action: {
                    type: 'object',
                    description: 'What to do when triggered. Either {tool: "name", params: {...}} to invoke a tool, or {message: "prompt"} to send to the agent.',
                },
                enabled: { type: 'boolean', description: 'Whether the trigger is active (default: true)' },
            },
            required: ['name', 'event', 'condition', 'action'],
        },
        execute: async (args) => {
            const error = validateTriggerInput(args);
            if (error) return error;

            const trigger: Trigger = {
                id: randomUUID(),
                name: args.name as string,
                event: args.event as TriggerEvent,
                condition: args.condition as TriggerCondition,
                action: args.action as TriggerAction,
                enabled: args.enabled !== false,
                created_at: new Date().toISOString(),
                fire_count: 0,
            };

            saveTrigger(trigger);
            logger.info(COMPONENT, `Created trigger: "${trigger.name}" (${trigger.event}) — ID: ${trigger.id}`);

            // Start file watcher immediately if applicable
            if (trigger.enabled && trigger.event === 'file_change') {
                startFileWatcher(trigger);
            }

            return [
                `Created trigger "${trigger.name}" (ID: ${trigger.id})`,
                `Event: ${trigger.event}`,
                `Condition: ${JSON.stringify(trigger.condition)}`,
                `Action: ${trigger.action.tool ? `tool "${trigger.action.tool}"` : `message "${trigger.action.message}"`}`,
                `Status: ${trigger.enabled ? 'enabled' : 'disabled'}`,
            ].join('\n');
        },
    });

    // Tool 2: trigger_list
    registerSkill(skillMeta, {
        name: 'trigger_list',
        description: 'List all event triggers with their status, last fired time, and fire count.',
        parameters: {
            type: 'object',
            properties: {},
        },
        execute: async () => {
            const triggers = loadAllTriggers();
            if (triggers.length === 0) return 'No event triggers configured.';

            return triggers.map(t => {
                const status = t.enabled ? 'enabled' : 'disabled';
                const lastFired = t.last_fired ? `Last fired: ${t.last_fired}` : 'Never fired';
                return [
                    `• ${t.name} [${status}]`,
                    `  ID: ${t.id}`,
                    `  Event: ${t.event}`,
                    `  Condition: ${JSON.stringify(t.condition)}`,
                    `  Action: ${t.action.tool ? `tool "${t.action.tool}"` : `message "${t.action.message}"`}`,
                    `  ${lastFired} | Fires: ${t.fire_count}`,
                ].join('\n');
            }).join('\n\n');
        },
    });

    // Tool 3: trigger_delete
    registerSkill(skillMeta, {
        name: 'trigger_delete',
        description: 'Delete an event trigger by name.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the trigger to delete' },
            },
            required: ['name'],
        },
        execute: async (args) => {
            const name = args.name as string;
            if (!name) return 'Error: "name" is required';

            const trigger = findTriggerByName(name);
            if (!trigger) return `Error: no trigger found with name "${name}"`;

            deleteTriggerFile(trigger.id);
            logger.info(COMPONENT, `Deleted trigger: "${name}" (${trigger.id})`);
            return `Deleted trigger "${name}" (ID: ${trigger.id})`;
        },
    });

    // Tool 4: trigger_toggle
    registerSkill(skillMeta, {
        name: 'trigger_toggle',
        description: 'Enable or disable an event trigger by name.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the trigger to toggle' },
                enabled: { type: 'boolean', description: 'Set to true to enable, false to disable' },
            },
            required: ['name', 'enabled'],
        },
        execute: async (args) => {
            const name = args.name as string;
            const enabled = args.enabled as boolean;

            if (!name) return 'Error: "name" is required';
            if (typeof enabled !== 'boolean') return 'Error: "enabled" must be true or false';

            const trigger = findTriggerByName(name);
            if (!trigger) return `Error: no trigger found with name "${name}"`;

            trigger.enabled = enabled;
            saveTrigger(trigger);

            // Manage file watchers
            if (trigger.event === 'file_change') {
                if (enabled) {
                    startFileWatcher(trigger);
                } else {
                    const watcher = activeWatchers.get(trigger.id);
                    if (watcher) {
                        watcher.close();
                        activeWatchers.delete(trigger.id);
                    }
                }
            }

            logger.info(COMPONENT, `${enabled ? 'Enabled' : 'Disabled'} trigger: "${name}"`);
            return `${enabled ? 'Enabled' : 'Disabled'} trigger "${name}" (ID: ${trigger.id})`;
        },
    });

    // Tool 5: trigger_test
    registerSkill(skillMeta, {
        name: 'trigger_test',
        description: 'Simulate firing a trigger to test its action without waiting for the real event.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the trigger to test' },
            },
            required: ['name'],
        },
        execute: async (args) => {
            const name = args.name as string;
            if (!name) return 'Error: "name" is required';

            const trigger = findTriggerByName(name);
            if (!trigger) return `Error: no trigger found with name "${name}"`;

            const result = await fireTrigger(trigger, true);
            return `[TEST FIRE] Trigger "${name}":\n${result}`;
        },
    });

    // Tool 6: trigger_log
    registerSkill(skillMeta, {
        name: 'trigger_log',
        description: 'View recent trigger fire history (last 50 events).',
        parameters: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Number of recent entries to show (default: 20, max: 50)' },
            },
        },
        execute: async (args) => {
            const limit = Math.min(Math.max((args.limit as number) || 20, 1), MAX_LOG_ENTRIES);
            const log = loadFireLog();

            if (log.length === 0) return 'No trigger fire events recorded.';

            const entries = log.slice(-limit).reverse();
            return entries.map((entry, i) => {
                const sim = entry.simulated ? ' [SIMULATED]' : '';
                return [
                    `${i + 1}. ${entry.trigger_name}${sim}`,
                    `   Event: ${entry.event} | Fired: ${entry.fired_at}`,
                    `   Result: ${entry.result}`,
                ].join('\n');
            }).join('\n\n');
        },
    });

    logger.info(COMPONENT, 'Event triggers skill registered (6 tools)');
}
