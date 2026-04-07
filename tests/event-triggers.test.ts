/**
 * TITAN -- Event Triggers Skill Tests
 * Tests src/skills/builtin/event_triggers.ts: trigger CRUD, toggle, test fire, logging, persistence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Capture registered tools
const registeredTools: Map<string, {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<string>;
}> = new Map();

vi.mock('../src/skills/registry.js', () => ({
    registerSkill: (_meta: unknown, tool: unknown) => {
        const t = tool as { name: string; description: string; parameters: Record<string, unknown>; execute: (args: Record<string, unknown>) => Promise<string> };
        registeredTools.set(t.name, t);
    },
}));

// Use a temp directory so we don't touch the real ~/.titan
vi.mock('../src/utils/constants.js', async () => {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    return {
        TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: join(tmpdir(), 'titan-test-evttrig'),
    };
});

import { registerEventTriggersSkill } from '../src/skills/builtin/event_triggers.js';
import { TITAN_HOME } from '../src/utils/constants.js';

// ─── Helpers ────────────────────────────────────────────────────

const TRIGGERS_DIR = join(TITAN_HOME, 'triggers');

function cleanTriggersDir() {
    if (existsSync(TRIGGERS_DIR)) {
        rmSync(TRIGGERS_DIR, { recursive: true, force: true });
    }
}

function getTool(name: string) {
    const tool = registeredTools.get(name);
    if (!tool) throw new Error(`Tool "${name}" not registered`);
    return tool;
}

// ─── Setup ──────────────────────────────────────────────────────

beforeEach(() => {
    registeredTools.clear();
    cleanTriggersDir();
    registerEventTriggersSkill();
});

afterEach(() => {
    cleanTriggersDir();
});

// ─── Tests ──────────────────────────────────────────────────────

describe('Event Triggers Skill', () => {
    // --- Registration ---

    it('registers all 6 tools', () => {
        expect(registeredTools.has('trigger_create')).toBe(true);
        expect(registeredTools.has('trigger_list')).toBe(true);
        expect(registeredTools.has('trigger_delete')).toBe(true);
        expect(registeredTools.has('trigger_toggle')).toBe(true);
        expect(registeredTools.has('trigger_test')).toBe(true);
        expect(registeredTools.has('trigger_log')).toBe(true);
    });

    // --- trigger_create ---

    it('creates a file_change trigger', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'watch-csv',
            event: 'file_change',
            condition: { path: '/tmp', pattern: '*.csv' },
            action: { tool: 'shell', params: { command: 'echo new csv' } },
        });

        expect(result).toContain('Created trigger "watch-csv"');
        expect(result).toContain('file_change');
        expect(result).toContain('enabled');
    });

    it('creates a webhook trigger', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'deploy-hook',
            event: 'webhook',
            condition: { endpoint: '/hooks/deploy' },
            action: { message: 'A deployment webhook was received' },
        });

        expect(result).toContain('Created trigger "deploy-hook"');
        expect(result).toContain('webhook');
    });

    it('creates a custom trigger', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'custom-event',
            event: 'custom',
            condition: { key: 'value' },
            action: { tool: 'shell', params: { command: 'echo custom' } },
        });

        expect(result).toContain('Created trigger "custom-event"');
    });

    it('creates an email trigger', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'email-alert',
            event: 'email',
            condition: { from: 'alerts@example.com', subject: 'CRITICAL' },
            action: { message: 'Critical email received' },
        });

        expect(result).toContain('Created trigger "email-alert"');
        expect(result).toContain('email');
    });

    it('creates a system trigger', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'on-startup',
            event: 'system',
            condition: { event: 'startup' },
            action: { tool: 'shell', params: { command: 'echo booted' } },
        });

        expect(result).toContain('Created trigger "on-startup"');
        expect(result).toContain('system');
    });

    it('rejects invalid event type', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'bad',
            event: 'nonexistent',
            condition: {},
            action: { tool: 'x' },
        });

        expect(result).toContain('Error');
        expect(result).toContain('event');
    });

    it('rejects missing name', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            event: 'custom',
            condition: { key: 'val' },
            action: { tool: 'x' },
        });

        expect(result).toContain('Error');
        expect(result).toContain('name');
    });

    it('rejects missing action tool and message', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'bad-action',
            event: 'custom',
            condition: { key: 'val' },
            action: {},
        });

        expect(result).toContain('Error');
        expect(result).toContain('tool');
    });

    it('rejects duplicate trigger names', async () => {
        const tool = getTool('trigger_create');
        await tool.execute({
            name: 'dup-test',
            event: 'custom',
            condition: { key: 'a' },
            action: { tool: 'shell' },
        });

        const result = await tool.execute({
            name: 'dup-test',
            event: 'custom',
            condition: { key: 'b' },
            action: { tool: 'shell' },
        });

        expect(result).toContain('Error');
        expect(result).toContain('already exists');
    });

    it('rejects file_change without path', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'no-path',
            event: 'file_change',
            condition: { pattern: '*.txt' },
            action: { tool: 'shell' },
        });

        expect(result).toContain('Error');
        expect(result).toContain('path');
    });

    it('rejects webhook without endpoint', async () => {
        const tool = getTool('trigger_create');
        const result = await tool.execute({
            name: 'no-endpoint',
            event: 'webhook',
            condition: {},
            action: { tool: 'shell' },
        });

        expect(result).toContain('Error');
        expect(result).toContain('endpoint');
    });

    // --- trigger_list ---

    it('lists triggers correctly', async () => {
        const create = getTool('trigger_create');
        await create.execute({
            name: 'trigger-a',
            event: 'custom',
            condition: { key: 'a' },
            action: { tool: 'shell', params: { command: 'echo a' } },
        });
        await create.execute({
            name: 'trigger-b',
            event: 'webhook',
            condition: { endpoint: '/hooks/b' },
            action: { message: 'hook b fired' },
        });

        const list = getTool('trigger_list');
        const result = await list.execute({});

        expect(result).toContain('trigger-a');
        expect(result).toContain('trigger-b');
        expect(result).toContain('custom');
        expect(result).toContain('webhook');
    });

    it('returns empty message when no triggers', async () => {
        const list = getTool('trigger_list');
        const result = await list.execute({});
        expect(result).toContain('No event triggers configured');
    });

    // --- trigger_delete ---

    it('deletes a trigger by name', async () => {
        const create = getTool('trigger_create');
        await create.execute({
            name: 'to-delete',
            event: 'custom',
            condition: { key: 'x' },
            action: { tool: 'shell' },
        });

        const del = getTool('trigger_delete');
        const result = await del.execute({ name: 'to-delete' });
        expect(result).toContain('Deleted trigger "to-delete"');

        const list = getTool('trigger_list');
        const listResult = await list.execute({});
        expect(listResult).toContain('No event triggers configured');
    });

    it('returns error for non-existent trigger delete', async () => {
        const del = getTool('trigger_delete');
        const result = await del.execute({ name: 'ghost' });
        expect(result).toContain('Error');
        expect(result).toContain('ghost');
    });

    // --- trigger_toggle ---

    it('disables and re-enables a trigger', async () => {
        const create = getTool('trigger_create');
        await create.execute({
            name: 'toggleable',
            event: 'custom',
            condition: { key: 'x' },
            action: { tool: 'shell' },
        });

        const toggle = getTool('trigger_toggle');

        // Disable
        const disableResult = await toggle.execute({ name: 'toggleable', enabled: false });
        expect(disableResult).toContain('Disabled');

        // Check list shows disabled
        const list = getTool('trigger_list');
        const listResult = await list.execute({});
        expect(listResult).toContain('disabled');

        // Re-enable
        const enableResult = await toggle.execute({ name: 'toggleable', enabled: true });
        expect(enableResult).toContain('Enabled');
    });

    it('returns error for toggle on non-existent trigger', async () => {
        const toggle = getTool('trigger_toggle');
        const result = await toggle.execute({ name: 'nope', enabled: true });
        expect(result).toContain('Error');
    });

    // --- trigger_test ---

    it('test-fires a trigger with tool action', async () => {
        const create = getTool('trigger_create');
        await create.execute({
            name: 'test-fire-tool',
            event: 'custom',
            condition: { key: 'val' },
            action: { tool: 'shell', params: { command: 'echo hello' } },
        });

        const test = getTool('trigger_test');
        const result = await test.execute({ name: 'test-fire-tool' });

        expect(result).toContain('TEST FIRE');
        expect(result).toContain('test-fire-tool');
        expect(result).toContain('shell');
    });

    it('test-fires a trigger with message action', async () => {
        const create = getTool('trigger_create');
        await create.execute({
            name: 'test-fire-msg',
            event: 'email',
            condition: { from: 'test@test.com' },
            action: { message: 'You got mail' },
        });

        const test = getTool('trigger_test');
        const result = await test.execute({ name: 'test-fire-msg' });

        expect(result).toContain('TEST FIRE');
        expect(result).toContain('You got mail');
    });

    // --- trigger_log ---

    it('shows fire log after test fires', async () => {
        const create = getTool('trigger_create');
        await create.execute({
            name: 'log-test',
            event: 'custom',
            condition: { key: 'x' },
            action: { tool: 'shell', params: { command: 'echo log' } },
        });

        const test = getTool('trigger_test');
        await test.execute({ name: 'log-test' });

        const log = getTool('trigger_log');
        const result = await log.execute({});

        expect(result).toContain('log-test');
        expect(result).toContain('SIMULATED');
    });

    it('returns empty message when no log entries', async () => {
        const log = getTool('trigger_log');
        const result = await log.execute({});
        expect(result).toContain('No trigger fire events recorded');
    });

    // --- Persistence ---

    it('persists triggers as JSON files in triggers directory', async () => {
        const create = getTool('trigger_create');
        await create.execute({
            name: 'persist-check',
            event: 'custom',
            condition: { key: 'persist' },
            action: { tool: 'shell' },
        });

        expect(existsSync(TRIGGERS_DIR)).toBe(true);

        const files = readdirSync(TRIGGERS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
        expect(files.length).toBe(1);

        const content = JSON.parse(readFileSync(join(TRIGGERS_DIR, files[0]), 'utf-8'));
        expect(content.name).toBe('persist-check');
        expect(content.event).toBe('custom');
        expect(content.fire_count).toBe(0);
    });

    it('creates trigger as disabled when enabled=false', async () => {
        const create = getTool('trigger_create');
        const result = await create.execute({
            name: 'disabled-trigger',
            event: 'custom',
            condition: { key: 'x' },
            action: { tool: 'shell' },
            enabled: false,
        });

        expect(result).toContain('disabled');

        const list = getTool('trigger_list');
        const listResult = await list.execute({});
        expect(listResult).toContain('disabled');
    });
});
