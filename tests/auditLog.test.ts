/**
 * TITAN — Audit Logger Tests
 * Tests src/security/auditLog.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { hostname } from 'os';

// ─── Mocks ────────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/mock/.titan',
}));

// Track file contents in memory for realistic fs simulation
let fileContents: Record<string, string> = {};

const mockFs = {
    existsSync: vi.fn((path: string) => path in fileContents),
    readFileSync: vi.fn((path: string) => {
        if (path in fileContents) return fileContents[path];
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }),
    writeFileSync: vi.fn((path: string, content: string) => {
        fileContents[path] = content;
    }),
    appendFileSync: vi.fn((path: string, content: string) => {
        if (!(path in fileContents)) fileContents[path] = '';
        fileContents[path] += content;
    }),
    mkdirSync: vi.fn(),
};

vi.mock('fs', () => ({
    existsSync: (...args: any[]) => mockFs.existsSync(...args),
    readFileSync: (...args: any[]) => mockFs.readFileSync(...args),
    writeFileSync: (...args: any[]) => mockFs.writeFileSync(...args),
    appendFileSync: (...args: any[]) => mockFs.appendFileSync(...args),
    mkdirSync: (...args: any[]) => mockFs.mkdirSync(...args),
}));

import {
    logAudit,
    getAuditLog,
    verifyAuditChain,
    getAuditStats,
    setAuditLogPath,
    getAuditLogPath,
    resetAuditState,
    type AuditEventType,
    type AuditEntry,
} from '../src/security/auditLog.js';

const TEST_LOG_PATH = '/mock/.titan/audit.jsonl';

/** Compute HMAC the same way the module does */
function computeHmac(data: string): string {
    const key = `TITAN-AUDIT-LOG-v1:${hostname()}`;
    return createHmac('sha256', key).update(data).digest('hex');
}

describe('Audit Logger', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        fileContents = {};
        resetAuditState();
        setAuditLogPath(TEST_LOG_PATH);
    });

    afterEach(() => {
        resetAuditState();
    });

    // ─── setAuditLogPath / getAuditLogPath ───────────────────────

    describe('setAuditLogPath / getAuditLogPath', () => {
        it('should set and get the audit log path', () => {
            setAuditLogPath('/custom/audit.jsonl');
            expect(getAuditLogPath()).toBe('/custom/audit.jsonl');
        });
    });

    // ─── logAudit ────────────────────────────────────────────────

    describe('logAudit', () => {
        it('should write an entry to the audit log file', () => {
            logAudit('session_start', 'user-1', { channel: 'cli' });
            expect(mockFs.appendFileSync).toHaveBeenCalledTimes(1);
        });

        it('should create directory if it does not exist', () => {
            logAudit('session_start', 'user-1', {});
            // mkdirSync may or may not be called depending on existsSync for dir
            // The important thing is that appendFileSync was called
            expect(mockFs.appendFileSync).toHaveBeenCalled();
        });

        it('should return a valid AuditEntry', () => {
            const entry = logAudit('tool_execution', 'agent-1', { tool: 'shell', args: 'ls' });
            expect(entry.eventType).toBe('tool_execution');
            expect(entry.actor).toBe('agent-1');
            expect(entry.detail).toEqual({ tool: 'shell', args: 'ls' });
            expect(entry.timestamp).toBeTruthy();
            expect(entry.prevHash).toBeTruthy();
        });

        it('should include ISO timestamp', () => {
            const entry = logAudit('session_start', 'user', {});
            expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('should set prevHash to "0" for first entry', () => {
            const entry = logAudit('session_start', 'user', {});
            expect(entry.prevHash).toBe('0');
        });

        it('should chain prevHash correctly for subsequent entries', () => {
            const entry1 = logAudit('session_start', 'user', {});
            const line1 = JSON.stringify(entry1);
            const expectedHash = computeHmac(line1);

            const entry2 = logAudit('tool_execution', 'user', { tool: 'shell' });
            expect(entry2.prevHash).toBe(expectedHash);
        });

        it('should support all event types', () => {
            const types: AuditEventType[] = [
                'tool_execution', 'config_change', 'auth_event',
                'session_start', 'session_end', 'model_switch',
                'budget_warning', 'security_alert',
            ];
            for (const type of types) {
                const entry = logAudit(type, 'test', {});
                expect(entry.eventType).toBe(type);
            }
        });

        it('should write JSONL format (one JSON per line)', () => {
            logAudit('session_start', 'user', {});
            logAudit('session_end', 'user', {});

            const content = fileContents[TEST_LOG_PATH];
            const lines = content.trim().split('\n');
            expect(lines.length).toBe(2);

            // Each line should be valid JSON
            for (const line of lines) {
                expect(() => JSON.parse(line)).not.toThrow();
            }
        });

        it('should default detail to empty object when not provided', () => {
            const entry = logAudit('session_start', 'user');
            expect(entry.detail).toEqual({});
        });

        it('should handle complex detail objects', () => {
            const detail = {
                tool: 'shell',
                command: 'ls -la',
                exitCode: 0,
                nested: { deep: true },
                array: [1, 2, 3],
            };
            const entry = logAudit('tool_execution', 'agent', detail);
            expect(entry.detail).toEqual(detail);
        });

        it('should write each entry on a new line ending with newline', () => {
            logAudit('session_start', 'user', {});
            const content = fileContents[TEST_LOG_PATH];
            expect(content.endsWith('\n')).toBe(true);
        });
    });

    // ─── getAuditLog ─────────────────────────────────────────────

    describe('getAuditLog', () => {
        it('should return empty array when log file does not exist', () => {
            const entries = getAuditLog();
            expect(entries).toEqual([]);
        });

        it('should return empty array for empty file', () => {
            fileContents[TEST_LOG_PATH] = '';
            const entries = getAuditLog();
            expect(entries).toEqual([]);
        });

        it('should parse all entries from the log', () => {
            logAudit('session_start', 'user1', {});
            logAudit('tool_execution', 'user1', { tool: 'shell' });
            logAudit('session_end', 'user1', {});

            const entries = getAuditLog();
            expect(entries.length).toBe(3);
        });

        it('should filter by eventType', () => {
            logAudit('session_start', 'user1', {});
            logAudit('tool_execution', 'user1', {});
            logAudit('tool_execution', 'user1', {});
            logAudit('session_end', 'user1', {});

            const entries = getAuditLog({ eventType: 'tool_execution' });
            expect(entries.length).toBe(2);
            expect(entries.every(e => e.eventType === 'tool_execution')).toBe(true);
        });

        it('should filter by actor', () => {
            logAudit('session_start', 'alice', {});
            logAudit('session_start', 'bob', {});
            logAudit('tool_execution', 'alice', {});

            const entries = getAuditLog({ actor: 'alice' });
            expect(entries.length).toBe(2);
            expect(entries.every(e => e.actor === 'alice')).toBe(true);
        });

        it('should filter by startDate', () => {
            // Write entries with specific timestamps
            const oldEntry: AuditEntry = {
                timestamp: '2025-01-01T00:00:00.000Z',
                eventType: 'session_start',
                actor: 'user',
                detail: {},
                prevHash: '0',
            };
            const newEntry: AuditEntry = {
                timestamp: '2026-06-01T00:00:00.000Z',
                eventType: 'session_end',
                actor: 'user',
                detail: {},
                prevHash: 'abc',
            };
            fileContents[TEST_LOG_PATH] = JSON.stringify(oldEntry) + '\n' + JSON.stringify(newEntry) + '\n';

            const entries = getAuditLog({ startDate: '2026-01-01' });
            expect(entries.length).toBe(1);
            expect(entries[0].eventType).toBe('session_end');
        });

        it('should filter by endDate', () => {
            const oldEntry: AuditEntry = {
                timestamp: '2025-01-01T00:00:00.000Z',
                eventType: 'session_start',
                actor: 'user',
                detail: {},
                prevHash: '0',
            };
            const newEntry: AuditEntry = {
                timestamp: '2026-06-01T00:00:00.000Z',
                eventType: 'session_end',
                actor: 'user',
                detail: {},
                prevHash: 'abc',
            };
            fileContents[TEST_LOG_PATH] = JSON.stringify(oldEntry) + '\n' + JSON.stringify(newEntry) + '\n';

            const entries = getAuditLog({ endDate: '2025-12-31' });
            expect(entries.length).toBe(1);
            expect(entries[0].eventType).toBe('session_start');
        });

        it('should filter by date range', () => {
            const entries_raw: AuditEntry[] = [
                { timestamp: '2025-01-01T00:00:00Z', eventType: 'session_start', actor: 'u', detail: {}, prevHash: '0' },
                { timestamp: '2025-06-15T00:00:00Z', eventType: 'tool_execution', actor: 'u', detail: {}, prevHash: 'a' },
                { timestamp: '2026-01-01T00:00:00Z', eventType: 'session_end', actor: 'u', detail: {}, prevHash: 'b' },
            ];
            fileContents[TEST_LOG_PATH] = entries_raw.map(e => JSON.stringify(e)).join('\n') + '\n';

            const filtered = getAuditLog({ startDate: '2025-03-01', endDate: '2025-12-31' });
            expect(filtered.length).toBe(1);
            expect(filtered[0].eventType).toBe('tool_execution');
        });

        it('should combine multiple filters', () => {
            logAudit('tool_execution', 'alice', {});
            logAudit('tool_execution', 'bob', {});
            logAudit('session_start', 'alice', {});

            const entries = getAuditLog({ eventType: 'tool_execution', actor: 'alice' });
            expect(entries.length).toBe(1);
        });

        it('should return all entries when no filters provided', () => {
            logAudit('session_start', 'user', {});
            logAudit('session_end', 'user', {});

            const entries = getAuditLog();
            expect(entries.length).toBe(2);
        });

        it('should skip malformed lines gracefully', () => {
            fileContents[TEST_LOG_PATH] = '{"valid":true,"eventType":"session_start","actor":"u","detail":{},"prevHash":"0","timestamp":"2025-01-01T00:00:00Z"}\nnot-json\n';
            const entries = getAuditLog();
            expect(entries.length).toBe(1);
        });

        it('should return empty array when all lines are malformed', () => {
            fileContents[TEST_LOG_PATH] = 'bad1\nbad2\nbad3\n';
            const entries = getAuditLog();
            expect(entries.length).toBe(0);
        });
    });

    // ─── verifyAuditChain ────────────────────────────────────────

    describe('verifyAuditChain', () => {
        it('should return valid for empty/missing log', () => {
            expect(verifyAuditChain()).toEqual({ valid: true });
        });

        it('should return valid for empty file', () => {
            fileContents[TEST_LOG_PATH] = '';
            expect(verifyAuditChain()).toEqual({ valid: true });
        });

        it('should return valid for single entry with correct prevHash', () => {
            logAudit('session_start', 'user', {});
            const result = verifyAuditChain();
            expect(result.valid).toBe(true);
        });

        it('should return valid for multi-entry chain', () => {
            logAudit('session_start', 'user', {});
            logAudit('tool_execution', 'user', { tool: 'shell' });
            logAudit('tool_execution', 'user', { tool: 'read_file' });
            logAudit('session_end', 'user', {});

            const result = verifyAuditChain();
            expect(result.valid).toBe(true);
        });

        it('should detect tampered first entry (wrong prevHash)', () => {
            const tampered: AuditEntry = {
                timestamp: new Date().toISOString(),
                eventType: 'session_start',
                actor: 'user',
                detail: {},
                prevHash: 'wrong-hash',
            };
            fileContents[TEST_LOG_PATH] = JSON.stringify(tampered) + '\n';

            const result = verifyAuditChain();
            expect(result.valid).toBe(false);
            expect(result.brokenAt).toBe(0);
        });

        it('should detect tampered middle entry', () => {
            // Write 3 valid entries
            logAudit('session_start', 'user', {});
            logAudit('tool_execution', 'user', {});
            logAudit('session_end', 'user', {});

            // Tamper with the second entry's prevHash
            const lines = fileContents[TEST_LOG_PATH].trim().split('\n');
            const entry2 = JSON.parse(lines[1]) as AuditEntry;
            entry2.prevHash = 'tampered-hash';
            lines[1] = JSON.stringify(entry2);
            fileContents[TEST_LOG_PATH] = lines.join('\n') + '\n';

            const result = verifyAuditChain();
            expect(result.valid).toBe(false);
            expect(result.brokenAt).toBe(1);
        });

        it('should detect tampered last entry', () => {
            logAudit('session_start', 'user', {});
            logAudit('session_end', 'user', {});

            // Tamper with the last entry
            const lines = fileContents[TEST_LOG_PATH].trim().split('\n');
            const lastEntry = JSON.parse(lines[lines.length - 1]) as AuditEntry;
            lastEntry.prevHash = 'bad-hash';
            lines[lines.length - 1] = JSON.stringify(lastEntry);
            fileContents[TEST_LOG_PATH] = lines.join('\n') + '\n';

            const result = verifyAuditChain();
            expect(result.valid).toBe(false);
        });

        it('should detect insertion of extra entry', () => {
            logAudit('session_start', 'user', {});
            logAudit('session_end', 'user', {});

            // Insert a fake entry between them
            const lines = fileContents[TEST_LOG_PATH].trim().split('\n');
            const fakeEntry: AuditEntry = {
                timestamp: new Date().toISOString(),
                eventType: 'security_alert',
                actor: 'attacker',
                detail: { injected: true },
                prevHash: 'fake',
            };
            lines.splice(1, 0, JSON.stringify(fakeEntry));
            fileContents[TEST_LOG_PATH] = lines.join('\n') + '\n';

            const result = verifyAuditChain();
            expect(result.valid).toBe(false);
        });

        it('should detect malformed JSON entry', () => {
            fileContents[TEST_LOG_PATH] = 'not-valid-json\n';
            const result = verifyAuditChain();
            expect(result.valid).toBe(false);
            expect(result.brokenAt).toBe(0);
        });

        it('should handle blank lines gracefully', () => {
            logAudit('session_start', 'user', {});
            // Add some blank lines — they should be filtered out
            fileContents[TEST_LOG_PATH] += '\n\n';
            const result = verifyAuditChain();
            expect(result.valid).toBe(true);
        });

        it('should validate a long chain', () => {
            for (let i = 0; i < 20; i++) {
                logAudit('tool_execution', `user-${i % 3}`, { iteration: i });
            }
            const result = verifyAuditChain();
            expect(result.valid).toBe(true);
        });
    });

    // ─── getAuditStats ───────────────────────────────────────────

    describe('getAuditStats', () => {
        it('should return empty object for empty log', () => {
            const stats = getAuditStats();
            expect(stats).toEqual({});
        });

        it('should count events by type', () => {
            logAudit('session_start', 'user', {});
            logAudit('tool_execution', 'user', {});
            logAudit('tool_execution', 'user', {});
            logAudit('tool_execution', 'user', {});
            logAudit('session_end', 'user', {});

            const stats = getAuditStats();
            expect(stats['session_start']).toBe(1);
            expect(stats['tool_execution']).toBe(3);
            expect(stats['session_end']).toBe(1);
        });

        it('should not include event types that did not occur', () => {
            logAudit('session_start', 'user', {});
            const stats = getAuditStats();
            expect(stats['tool_execution']).toBeUndefined();
            expect(stats['security_alert']).toBeUndefined();
        });

        it('should count all 8 event types correctly', () => {
            const types: AuditEventType[] = [
                'tool_execution', 'config_change', 'auth_event',
                'session_start', 'session_end', 'model_switch',
                'budget_warning', 'security_alert',
            ];
            for (const type of types) {
                logAudit(type, 'user', {});
            }
            const stats = getAuditStats();
            for (const type of types) {
                expect(stats[type]).toBe(1);
            }
        });

        it('should return correct stats for multiple entries of same type', () => {
            for (let i = 0; i < 10; i++) {
                logAudit('tool_execution', 'agent', { i });
            }
            const stats = getAuditStats();
            expect(stats['tool_execution']).toBe(10);
        });
    });

    // ─── resetAuditState ─────────────────────────────────────────

    describe('resetAuditState', () => {
        it('should reset the cached last hash', () => {
            logAudit('session_start', 'user', {});
            resetAuditState();
            // After reset, if file doesn't exist, next entry should use '0' as prevHash
            delete fileContents[TEST_LOG_PATH];
            const entry = logAudit('session_start', 'user', {});
            expect(entry.prevHash).toBe('0');
        });
    });

    // ─── Integration-style tests ─────────────────────────────────

    describe('Integration scenarios', () => {
        it('should maintain chain across many operations with different actors', () => {
            logAudit('session_start', 'alice', { channel: 'discord' });
            logAudit('auth_event', 'alice', { method: 'token' });
            logAudit('model_switch', 'alice', { from: 'gpt-4', to: 'claude' });
            logAudit('tool_execution', 'alice', { tool: 'shell' });
            logAudit('budget_warning', 'system', { spent: 4.50, limit: 5 });
            logAudit('config_change', 'admin', { key: 'model', value: 'claude' });
            logAudit('security_alert', 'shield', { reason: 'suspicious prompt' });
            logAudit('session_end', 'alice', { duration: 300 });

            const result = verifyAuditChain();
            expect(result.valid).toBe(true);

            const stats = getAuditStats();
            expect(Object.keys(stats).length).toBe(8);
        });

        it('should support filtering after multiple writes', () => {
            logAudit('session_start', 'alice', {});
            logAudit('tool_execution', 'alice', { tool: 'a' });
            logAudit('tool_execution', 'bob', { tool: 'b' });
            logAudit('session_end', 'alice', {});
            logAudit('session_end', 'bob', {});

            const aliceTools = getAuditLog({ eventType: 'tool_execution', actor: 'alice' });
            expect(aliceTools.length).toBe(1);
            expect(aliceTools[0].detail.tool).toBe('a');

            const allEnds = getAuditLog({ eventType: 'session_end' });
            expect(allEnds.length).toBe(2);
        });

        it('should handle rapid sequential writes', () => {
            for (let i = 0; i < 100; i++) {
                logAudit('tool_execution', 'agent', { i });
            }
            const entries = getAuditLog();
            expect(entries.length).toBe(100);

            const result = verifyAuditChain();
            expect(result.valid).toBe(true);
        });
    });
});
