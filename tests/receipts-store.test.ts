import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mintActionId } from '../src/receipts/mint.js';
import { readReceipts, writeReceipt } from '../src/receipts/store.js';
import type { ToolCall } from '../src/providers/base.js';

vi.mock('../src/config/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/config/config.js')>();
    return {
        ...actual,
        loadConfig: vi.fn(() => {
            throw new Error('config exploded');
        }),
    };
});

let originalHome: string | undefined;
let originalTitanHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
    originalHome = process.env.HOME;
    originalTitanHome = process.env.TITAN_HOME;
    tmpHome = mkdtempSync(join(tmpdir(), 'titan-receipts-'));
    process.env.HOME = tmpHome;
    process.env.TITAN_HOME = tmpHome;
});

afterEach(() => {
    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }
    if (originalTitanHome === undefined) {
        delete process.env.TITAN_HOME;
    } else {
        process.env.TITAN_HOME = originalTitanHome;
    }
    rmSync(tmpHome, { recursive: true, force: true });
});

describe('receipt store', () => {
    it('fills action_id and ts when writing', () => {
        const receipt = writeReceipt({ kind: 'tool_call', summary: 'ran shell', status: 'ok' });

        expect(receipt.action_id).toMatch(/^[0-9a-f]{20}$/);
        expect(receipt.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(readReceipts()).toHaveLength(1);
    });

    it('truncates large meta payloads and long summaries', () => {
        const receipt = writeReceipt({
            kind: 'error',
            summary: 'x'.repeat(250),
            status: 'fail',
            meta: { payload: 'y'.repeat(5000) },
        });

        expect(receipt.summary).toHaveLength(200);
        expect(receipt.meta).toEqual({ truncated: true, bytes: expect.any(Number) });
        expect((receipt.meta as { bytes: number }).bytes).toBeGreaterThan(4096);
    });

    it('filters by kind, since, agent, and mission', () => {
        const first = writeReceipt({
            kind: 'tool_call',
            summary: 'alpha',
            status: 'ok',
            agent: 'agent-a',
            mission: 'mission-a',
        });
        const second = writeReceipt({
            kind: 'mission_start',
            summary: 'beta',
            status: 'ok',
            agent: 'agent-b',
            mission: 'mission-a',
        });
        writeReceipt({
            kind: 'error',
            summary: 'gamma',
            status: 'fail',
            agent: 'agent-a',
            mission: 'mission-b',
        });

        expect(readReceipts({ kind: 'tool_call' }).map(r => r.summary)).toEqual(['alpha']);
        expect(readReceipts({ kind: ['tool_call', 'mission_start'] }).map(r => r.summary)).toEqual(['beta', 'alpha']);
        expect(readReceipts({ since: second.ts }).map(r => r.summary)).toEqual(['gamma', 'beta']);
        expect(readReceipts({ agent: 'agent-a' }).map(r => r.summary)).toEqual(['gamma', 'alpha']);
        expect(readReceipts({ mission: 'mission-a' }).map(r => r.summary)).toEqual(['beta', 'alpha']);
        expect(readReceipts({ since: first.ts, kind: ['mission_start'], agent: 'agent-b', mission: 'mission-a' })).toHaveLength(1);
    });

    it('caps read limits at 1000', () => {
        for (let i = 0; i < 1100; i++) {
            writeReceipt({ kind: 'tool_call', summary: `tool ${i}`, status: 'ok' });
        }

        const receipts = readReceipts({ limit: 2000 });
        expect(receipts).toHaveLength(1000);
        expect(receipts[0]?.summary).toBe('tool 1099');
    });

    it('mints monotonic 20-character action ids', () => {
        const ids = Array.from({ length: 1000 }, () => mintActionId());

        expect(ids.every(id => /^[0-9a-f]{20}$/.test(id))).toBe(true);
        for (let i = 1; i < ids.length; i++) {
            expect(ids[i]! > ids[i - 1]!).toBe(true);
        }
    });

    it('writes a failure receipt when executeTool throws before returning a ToolResult', async () => {
        const { executeTool } = await import('../src/agent/toolRunner.js');
        const call: ToolCall = {
            id: 'tc-receipt-throw',
            type: 'function',
            function: {
                name: 'receipt_throw_probe',
                arguments: JSON.stringify({
                    prompt: 'hello',
                    email: 'tony@example.com',
                    token: 'sk-test-secret',
                }),
            },
        };

        await expect(executeTool(call, 'test-channel')).rejects.toThrow('config exploded');

        const receipts = readReceipts({ kind: 'tool_call' });
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.status).toBe('fail');
        expect(receipts[0]?.summary).toContain('receipt_throw_probe');
        expect(receipts[0]?.summary).toContain('args=email,prompt,token');
        expect(receipts[0]?.summary).not.toContain('tony@example.com');
        expect(receipts[0]?.summary).not.toContain('sk-test-secret');
        expect(receipts[0]?.meta).toMatchObject({ error: 'config exploded' });
    });
});
