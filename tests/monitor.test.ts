/**
 * TITAN — Monitor Tests
 * Tests addMonitor, removeMonitor, listMonitors, getMonitorEvents,
 * setMonitorTriggerHandler, initMonitors, trigger, persistence, and error paths.
 *
 * Uses vi.resetModules() + dynamic re-import to get a fresh module for each test
 * (the monitor module has module-level state: activeWatchers, activeIntervals, eventLog, onTrigger).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock variables ──────────────────────────────────────────────
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockReadFileSync = vi.hoisted(() => vi.fn());
const mockWriteFileSync = vi.hoisted(() => vi.fn());
const mockMkdirSync = vi.hoisted(() => vi.fn());
const mockWatch = vi.hoisted(() => vi.fn());

// ── Module mocks ─────────────────────────────────────────────────────────
vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/utils/constants.js', () => ({
    TITAN_MD_FILENAME: 'TITAN.md',
    TITAN_HOME: '/tmp/titan-test-monitor',
}));

let mockFiles: Record<string, string> = {};

vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    return {
        ...actual,
        existsSync: mockExistsSync,
        readFileSync: mockReadFileSync,
        writeFileSync: mockWriteFileSync,
        mkdirSync: mockMkdirSync,
        watch: mockWatch,
    };
});

// ── Helper to get a fresh monitor module ────────────────────────────────
type MonitorModule = typeof import('../src/agent/monitor.js');

async function freshMonitor(): Promise<MonitorModule> {
    vi.resetModules();
    return await import('../src/agent/monitor.js');
}

// ── Helper to create a mock watcher ─────────────────────────────────────
function createMockWatcher() {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    return {
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
            if (!listeners[event]) listeners[event] = [];
            listeners[event].push(cb);
        }),
        close: vi.fn(),
        _listeners: listeners,
        _emit: (event: string, ...args: unknown[]) => {
            for (const cb of (listeners[event] || [])) cb(...args);
        },
    };
}

// ── Helper to create a stored monitor object ────────────────────────────
function makeStoredMonitor(overrides: Partial<{
    id: string; name: string; description: string; triggerType: string;
    watchPath: string; cronExpression: string; webhookPath: string;
    prompt: string; enabled: boolean; createdAt: string; triggerCount: number;
    lastTriggeredAt: string;
}> = {}) {
    return {
        id: overrides.id ?? 'mon-default',
        name: overrides.name ?? 'Default Monitor',
        description: overrides.description ?? '',
        triggerType: overrides.triggerType ?? 'webhook',
        watchPath: overrides.watchPath,
        cronExpression: overrides.cronExpression,
        webhookPath: overrides.webhookPath,
        prompt: overrides.prompt ?? '',
        enabled: overrides.enabled ?? false,
        createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
        triggerCount: overrides.triggerCount ?? 0,
        lastTriggeredAt: overrides.lastTriggeredAt,
    };
}

// ── Setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFiles = {};

    mockExistsSync.mockImplementation((p: string) => {
        if (p in mockFiles) return true;
        return false;
    });
    mockReadFileSync.mockImplementation((p: string) => {
        if (p in mockFiles) return mockFiles[p];
        throw new Error('ENOENT');
    });
    mockWriteFileSync.mockImplementation((p: string, data: string) => {
        mockFiles[p] = data;
    });
    mockMkdirSync.mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('Monitor System', () => {

    // ── listMonitors ────────────────────────────────────────────────

    describe('listMonitors', () => {
        it('should return an empty array when no monitors file exists', async () => {
            const mod = await freshMonitor();
            const monitors = mod.listMonitors();
            expect(monitors).toEqual([]);
        });

        it('should return monitors from persisted JSON', async () => {
            const stored = [{
                id: 'mon-1', name: 'Test Monitor', description: 'A test',
                triggerType: 'webhook', prompt: 'do something', enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            const monitors = mod.listMonitors();
            expect(monitors).toHaveLength(1);
            expect(monitors[0].id).toBe('mon-1');
        });

        it('should return empty array when monitors.json is corrupted', async () => {
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = 'NOT VALID JSON!!!';

            const mod = await freshMonitor();
            const monitors = mod.listMonitors();
            expect(monitors).toEqual([]);
        });

        it('should return multiple monitors from persisted JSON', async () => {
            const stored = [
                makeStoredMonitor({ id: 'mon-1', name: 'First' }),
                makeStoredMonitor({ id: 'mon-2', name: 'Second' }),
                makeStoredMonitor({ id: 'mon-3', name: 'Third' }),
            ];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            const monitors = mod.listMonitors();
            expect(monitors).toHaveLength(3);
            expect(monitors.map(m => m.id)).toEqual(['mon-1', 'mon-2', 'mon-3']);
        });

        it('should preserve all monitor fields when listing', async () => {
            const stored = [makeStoredMonitor({
                id: 'mon-full',
                name: 'Full Monitor',
                description: 'Detailed desc',
                triggerType: 'file_change',
                watchPath: '/some/path',
                prompt: 'Do work',
                enabled: true,
                triggerCount: 5,
                lastTriggeredAt: '2026-02-15T12:00:00.000Z',
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            const monitors = mod.listMonitors();
            expect(monitors[0].description).toBe('Detailed desc');
            expect(monitors[0].triggerCount).toBe(5);
            expect(monitors[0].lastTriggeredAt).toBe('2026-02-15T12:00:00.000Z');
        });
    });

    // ── addMonitor ──────────────────────────────────────────────────

    describe('addMonitor', () => {
        it('should add a new monitor and persist it', async () => {
            const mod = await freshMonitor();
            const monitor = mod.addMonitor({
                id: 'mon-new',
                name: 'New Monitor',
                description: 'Watches stuff',
                triggerType: 'webhook',
                prompt: 'Handle the webhook',
                enabled: false,
            });

            expect(monitor.id).toBe('mon-new');
            expect(monitor.triggerCount).toBe(0);
            expect(monitor.createdAt).toBeDefined();

            // Verify persistence
            expect(mockWriteFileSync).toHaveBeenCalled();
            const savedData = JSON.parse(mockFiles['/tmp/titan-test-monitor/monitors.json']);
            expect(savedData).toHaveLength(1);
            expect(savedData[0].id).toBe('mon-new');
        });

        it('should throw when adding a monitor with a duplicate id', async () => {
            const stored = [{
                id: 'mon-dup', name: 'Existing', description: '',
                triggerType: 'webhook', prompt: '', enabled: false,
                createdAt: '2026-01-01T00:00:00.000Z', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            expect(() => mod.addMonitor({
                id: 'mon-dup',
                name: 'Duplicate',
                description: '',
                triggerType: 'webhook',
                prompt: '',
                enabled: false,
            })).toThrow('already exists');
        });

        it('should start a file_change monitor when enabled and watchPath exists', async () => {
            const watcher = createMockWatcher();
            mockWatch.mockReturnValue(watcher);

            // Make the watch path exist
            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/watched-dir') return true;
                if (p in mockFiles) return true;
                return false;
            });

            const mod = await freshMonitor();
            const monitor = mod.addMonitor({
                id: 'mon-file',
                name: 'File Watcher',
                description: 'Watches a directory',
                triggerType: 'file_change',
                watchPath: '/tmp/watched-dir',
                prompt: 'Handle file change',
                enabled: true,
            });

            expect(mockWatch).toHaveBeenCalledWith(
                '/tmp/watched-dir',
                { recursive: true },
                expect.any(Function),
            );
        });

        it('should start a schedule monitor when enabled with cron expression', async () => {
            const mod = await freshMonitor();
            const monitor = mod.addMonitor({
                id: 'mon-sched',
                name: 'Scheduled Monitor',
                description: 'Runs every 5 minutes',
                triggerType: 'schedule',
                cronExpression: '*/5',
                prompt: 'Run scheduled task',
                enabled: true,
            });

            // The module should have set an interval — we can verify the logger was called
            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.info).toHaveBeenCalledWith('Monitor', expect.stringContaining('every 5 minutes'));
        });

        it('should NOT start a file_change monitor when watchPath does not exist', async () => {
            // existsSync returns false for everything by default
            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-missing-path',
                name: 'Missing Path',
                description: '',
                triggerType: 'file_change',
                watchPath: '/nonexistent/path',
                prompt: 'Handle it',
                enabled: true,
            });

            expect(mockWatch).not.toHaveBeenCalled();
            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.warn).toHaveBeenCalledWith('Monitor', expect.stringContaining('does not exist'));
        });

        it('should not start watcher when monitor is disabled', async () => {
            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/disabled-watch') return true;
                if (p in mockFiles) return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-disabled-file',
                name: 'Disabled Watcher',
                description: '',
                triggerType: 'file_change',
                watchPath: '/tmp/disabled-watch',
                prompt: 'Handle it',
                enabled: false,
            });

            expect(mockWatch).not.toHaveBeenCalled();
        });

        it('should set createdAt to a valid ISO timestamp', async () => {
            const mod = await freshMonitor();
            const monitor = mod.addMonitor({
                id: 'mon-ts',
                name: 'Timestamp',
                description: '',
                triggerType: 'webhook',
                prompt: '',
                enabled: false,
            });
            expect(new Date(monitor.createdAt).getTime()).not.toBeNaN();
        });

        it('should initialize triggerCount to 0', async () => {
            const mod = await freshMonitor();
            const monitor = mod.addMonitor({
                id: 'mon-count',
                name: 'Count',
                description: '',
                triggerType: 'webhook',
                prompt: '',
                enabled: false,
            });
            expect(monitor.triggerCount).toBe(0);
        });

        it('should add monitor alongside existing monitors', async () => {
            const stored = [makeStoredMonitor({ id: 'mon-existing', name: 'Existing' })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-second',
                name: 'Second',
                description: '',
                triggerType: 'webhook',
                prompt: '',
                enabled: false,
            });

            const savedData = JSON.parse(mockFiles['/tmp/titan-test-monitor/monitors.json']);
            expect(savedData).toHaveLength(2);
            expect(savedData[0].id).toBe('mon-existing');
            expect(savedData[1].id).toBe('mon-second');
        });

        it('should register error handler on file watcher', async () => {
            const watcher = createMockWatcher();
            mockWatch.mockReturnValue(watcher);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/err-watch') return true;
                if (p in mockFiles) return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-err-handler',
                name: 'Error Handler',
                description: '',
                triggerType: 'file_change',
                watchPath: '/tmp/err-watch',
                prompt: '',
                enabled: true,
            });

            expect(watcher.on).toHaveBeenCalledWith('error', expect.any(Function));
        });

        it('should handle webhook triggerType (no watcher, no interval)', async () => {
            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-webhook',
                name: 'Webhook',
                description: '',
                triggerType: 'webhook',
                webhookPath: '/hooks/test',
                prompt: 'handle webhook',
                enabled: true,
            });

            // No watcher or interval should be created for webhook
            expect(mockWatch).not.toHaveBeenCalled();
        });

        it('should create TITAN_HOME directory if it does not exist when saving', async () => {
            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-mkdir',
                name: 'Mkdir',
                description: '',
                triggerType: 'webhook',
                prompt: '',
                enabled: false,
            });

            expect(mockMkdirSync).toHaveBeenCalled();
        });
    });

    // ── removeMonitor ───────────────────────────────────────────────

    describe('removeMonitor', () => {
        it('should remove a monitor from persistence', async () => {
            const stored = [
                { id: 'mon-1', name: 'A', description: '', triggerType: 'webhook', prompt: '', enabled: false, createdAt: '2026-01-01', triggerCount: 0 },
                { id: 'mon-2', name: 'B', description: '', triggerType: 'webhook', prompt: '', enabled: false, createdAt: '2026-01-01', triggerCount: 0 },
            ];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            mod.removeMonitor('mon-1');

            const savedData = JSON.parse(mockFiles['/tmp/titan-test-monitor/monitors.json']);
            expect(savedData).toHaveLength(1);
            expect(savedData[0].id).toBe('mon-2');
        });

        it('should close watcher when removing an active file_change monitor', async () => {
            const watcher = createMockWatcher();
            mockWatch.mockReturnValue(watcher);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/watched') return true;
                if (p in mockFiles) return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-active',
                name: 'Active Watcher',
                description: '',
                triggerType: 'file_change',
                watchPath: '/tmp/watched',
                prompt: '',
                enabled: true,
            });

            mod.removeMonitor('mon-active');
            expect(watcher.close).toHaveBeenCalled();
        });

        it('should clear interval when removing an active schedule monitor', async () => {
            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-sched-remove',
                name: 'Scheduled',
                description: '',
                triggerType: 'schedule',
                cronExpression: '*/10',
                prompt: '',
                enabled: true,
            });

            // After removal, advancing timers should NOT trigger any events
            mod.removeMonitor('mon-sched-remove');
            await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

            const events = mod.getMonitorEvents();
            expect(events.length).toBe(0);
        });

        it('should handle removing a non-existent monitor gracefully', async () => {
            const mod = await freshMonitor();
            // Should not throw
            expect(() => mod.removeMonitor('non-existent')).not.toThrow();
        });

        it('should remove only the targeted monitor, leaving others intact', async () => {
            const stored = [
                makeStoredMonitor({ id: 'mon-keep-1', name: 'Keep 1' }),
                makeStoredMonitor({ id: 'mon-remove', name: 'Remove' }),
                makeStoredMonitor({ id: 'mon-keep-2', name: 'Keep 2' }),
            ];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            mod.removeMonitor('mon-remove');

            const savedData = JSON.parse(mockFiles['/tmp/titan-test-monitor/monitors.json']);
            expect(savedData).toHaveLength(2);
            expect(savedData.map((m: any) => m.id)).toEqual(['mon-keep-1', 'mon-keep-2']);
        });
    });

    // ── getMonitorEvents ────────────────────────────────────────────

    describe('getMonitorEvents', () => {
        it('should return an empty array initially', async () => {
            const mod = await freshMonitor();
            const events = mod.getMonitorEvents();
            expect(events).toEqual([]);
        });

        it('should return events after file change triggers', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-events',
                triggerType: 'file_change',
                watchPath: '/tmp/events-dir',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/events-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            fileChangeCallback!('change', 'a.txt');
            await vi.advanceTimersByTimeAsync(2100); // past debounce
            await vi.advanceTimersByTimeAsync(10_000); // past rate limit
            fileChangeCallback!('change', 'b.txt');
            await vi.advanceTimersByTimeAsync(2100); // past debounce

            const events = mod.getMonitorEvents();
            expect(events.length).toBe(2);
        });

        it('should return events in reverse chronological order (newest first)', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-order',
                triggerType: 'file_change',
                watchPath: '/tmp/order-dir',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/order-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            fileChangeCallback!('change', 'first.txt');
            await vi.advanceTimersByTimeAsync(2100); // past debounce
            await vi.advanceTimersByTimeAsync(10_000); // past rate limit
            fileChangeCallback!('change', 'second.txt');
            await vi.advanceTimersByTimeAsync(2100); // past debounce

            const events = mod.getMonitorEvents();
            // Newest event (second.txt) should be first
            expect(events[0].detail).toContain('second.txt');
            expect(events[1].detail).toContain('first.txt');
        });

        it('should include monitor id in each event', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-id-check',
                triggerType: 'file_change',
                watchPath: '/tmp/id-dir',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/id-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            fileChangeCallback!('change', 'test.txt');
            await vi.advanceTimersByTimeAsync(2100);

            const events = mod.getMonitorEvents();
            expect(events[0].monitorId).toBe('mon-id-check');
        });

        it('should include trigger type in each event', async () => {
            const stored = [makeStoredMonitor({
                id: 'mon-type-check',
                triggerType: 'schedule',
                cronExpression: '*/1',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            await vi.advanceTimersByTimeAsync(1 * 60 * 1000 + 100);

            const events = mod.getMonitorEvents();
            expect(events.length).toBeGreaterThanOrEqual(1);
            expect(events[0].triggerType).toBe('schedule');
        });
    });

    // ── setMonitorTriggerHandler ────────────────────────────────────

    describe('setMonitorTriggerHandler', () => {
        it('should accept a handler function without error', async () => {
            const mod = await freshMonitor();
            expect(() => {
                mod.setMonitorTriggerHandler(async () => {});
            }).not.toThrow();
        });

        it('should replace previous handler when called again', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-replace',
                triggerType: 'file_change',
                watchPath: '/tmp/replace-dir',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/replace-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const handler1 = vi.fn().mockResolvedValue(undefined);
            const handler2 = vi.fn().mockResolvedValue(undefined);

            const mod = await freshMonitor();
            mod.setMonitorTriggerHandler(handler1);
            mod.setMonitorTriggerHandler(handler2); // Replace
            mod.initMonitors();

            fileChangeCallback!('change', 'test.txt');
            await vi.advanceTimersByTimeAsync(2100);

            expect(handler1).not.toHaveBeenCalled();
            expect(handler2).toHaveBeenCalled();
        });
    });

    // ── initMonitors ────────────────────────────────────────────────

    describe('initMonitors', () => {
        it('should not throw when no monitors exist', async () => {
            const mod = await freshMonitor();
            expect(() => mod.initMonitors()).not.toThrow();
        });

        it('should activate enabled monitors on init', async () => {
            const watcher = createMockWatcher();
            mockWatch.mockReturnValue(watcher);

            const stored = [{
                id: 'mon-active', name: 'Active', description: '',
                triggerType: 'file_change', watchPath: '/tmp/watched',
                prompt: '', enabled: true, createdAt: '2026-01-01', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/watched') return true;
                if (p in mockFiles) return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            expect(mockWatch).toHaveBeenCalledWith('/tmp/watched', { recursive: true }, expect.any(Function));
            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.info).toHaveBeenCalledWith('Monitor', expect.stringContaining('Activated 1 monitor'));
        });

        it('should skip disabled monitors on init', async () => {
            const stored = [{
                id: 'mon-disabled', name: 'Disabled', description: '',
                triggerType: 'file_change', watchPath: '/tmp/watched',
                prompt: '', enabled: false, createdAt: '2026-01-01', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            mod.initMonitors();

            expect(mockWatch).not.toHaveBeenCalled();
        });

        it('should activate multiple enabled monitors on init', async () => {
            const watcher1 = createMockWatcher();
            const watcher2 = createMockWatcher();
            let callCount = 0;
            mockWatch.mockImplementation(() => {
                callCount++;
                return callCount === 1 ? watcher1 : watcher2;
            });

            const stored = [
                makeStoredMonitor({ id: 'mon-a', triggerType: 'file_change', watchPath: '/tmp/a', enabled: true }),
                makeStoredMonitor({ id: 'mon-b', triggerType: 'file_change', watchPath: '/tmp/b', enabled: true }),
            ];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/a' || p === '/tmp/b') return true;
                if (p in mockFiles) return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            expect(mockWatch).toHaveBeenCalledTimes(2);
            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.info).toHaveBeenCalledWith('Monitor', expect.stringContaining('Activated 2 monitor'));
        });

        it('should activate mix of file_change and schedule monitors', async () => {
            const watcher = createMockWatcher();
            mockWatch.mockReturnValue(watcher);

            const stored = [
                makeStoredMonitor({ id: 'mon-file', triggerType: 'file_change', watchPath: '/tmp/mix-dir', enabled: true }),
                makeStoredMonitor({ id: 'mon-sched', triggerType: 'schedule', cronExpression: '*/15', enabled: true }),
            ];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/mix-dir') return true;
                if (p in mockFiles) return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            expect(mockWatch).toHaveBeenCalledTimes(1);
            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.info).toHaveBeenCalledWith('Monitor', expect.stringContaining('every 15 minutes'));
        });

        it('should not log activation message when no enabled monitors exist', async () => {
            const stored = [
                makeStoredMonitor({ id: 'mon-off', enabled: false }),
            ];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            const logger = (await import('../src/utils/logger.js')).default;
            vi.mocked(logger.info).mockClear();

            mod.initMonitors();

            // Should NOT have logged "Activated N monitor(s)"
            const activationCalls = vi.mocked(logger.info).mock.calls.filter(
                c => typeof c[1] === 'string' && c[1].includes('Activated')
            );
            expect(activationCalls.length).toBe(0);
        });
    });

    // ── trigger behavior (file change callback) ─────────────────────

    describe('trigger (file change callback)', () => {
        it('should log event and update trigger count when file changes', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [{
                id: 'mon-fc', name: 'File Change', description: '',
                triggerType: 'file_change', watchPath: '/tmp/watched',
                prompt: 'Handle change', enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/watched') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            // Simulate a file change event
            expect(fileChangeCallback).not.toBeNull();
            fileChangeCallback!('change', 'data.json');

            // Allow debounce (2s) + async trigger to settle
            await vi.advanceTimersByTimeAsync(2100);

            const events = mod.getMonitorEvents();
            expect(events.length).toBeGreaterThanOrEqual(1);
            expect(events[0].detail).toContain('data.json');

            // Check that triggerCount was incremented in persisted data
            const savedData = JSON.parse(mockFiles['/tmp/titan-test-monitor/monitors.json']);
            expect(savedData[0].triggerCount).toBe(1);
        });

        it('should call the trigger handler when one is set', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [{
                id: 'mon-handler', name: 'Handler Test', description: '',
                triggerType: 'file_change', watchPath: '/tmp/watched',
                prompt: 'Do stuff', enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/watched') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const handler = vi.fn().mockResolvedValue(undefined);

            const mod = await freshMonitor();
            mod.setMonitorTriggerHandler(handler);
            mod.initMonitors();

            fileChangeCallback!('change', 'readme.md');
            await vi.advanceTimersByTimeAsync(2100);

            expect(handler).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'mon-handler' }),
                expect.objectContaining({ triggerType: 'file_change' }),
            );
        });

        it('should handle trigger handler errors gracefully', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [{
                id: 'mon-err', name: 'Error Handler', description: '',
                triggerType: 'file_change', watchPath: '/tmp/watched',
                prompt: 'Oops', enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/watched') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const handler = vi.fn().mockRejectedValue(new Error('Handler exploded'));

            const mod = await freshMonitor();
            mod.setMonitorTriggerHandler(handler);
            mod.initMonitors();

            fileChangeCallback!('change', 'test.txt');
            await vi.advanceTimersByTimeAsync(2100);

            // Should not throw — error is caught and logged
            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.error).toHaveBeenCalledWith('Monitor', expect.stringContaining('Monitor handler error'));
        });

        it('should include eventType in the detail string', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-etype',
                triggerType: 'file_change',
                watchPath: '/tmp/etype-dir',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/etype-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            fileChangeCallback!('rename', 'moved.txt');
            await vi.advanceTimersByTimeAsync(2100);

            const events = mod.getMonitorEvents();
            expect(events[0].detail).toContain('rename');
        });

        it('should update lastTriggeredAt in persisted data', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-lastTrig',
                triggerType: 'file_change',
                watchPath: '/tmp/trig-dir',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/trig-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            fileChangeCallback!('change', 'update.txt');
            await vi.advanceTimersByTimeAsync(2100);

            const savedData = JSON.parse(mockFiles['/tmp/titan-test-monitor/monitors.json']);
            expect(savedData[0].lastTriggeredAt).toBeTruthy();
        });

        it('should increment triggerCount on each trigger', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-multi-trig',
                triggerType: 'file_change',
                watchPath: '/tmp/multi-dir',
                enabled: true,
                triggerCount: 0,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/multi-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            // Events must be spaced past debounce (2s) + rate limit (10s) to each count
            fileChangeCallback!('change', 'a.txt');
            await vi.advanceTimersByTimeAsync(2100); // debounce fires trigger 1
            await vi.advanceTimersByTimeAsync(10_000); // past rate limit
            fileChangeCallback!('change', 'b.txt');
            await vi.advanceTimersByTimeAsync(2100); // debounce fires trigger 2
            await vi.advanceTimersByTimeAsync(10_000); // past rate limit
            fileChangeCallback!('change', 'c.txt');
            await vi.advanceTimersByTimeAsync(2100); // debounce fires trigger 3

            const savedData = JSON.parse(mockFiles['/tmp/titan-test-monitor/monitors.json']);
            expect(savedData[0].triggerCount).toBe(3);
        });

        it('should pass monitor object with correct prompt to handler', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-prompt',
                triggerType: 'file_change',
                watchPath: '/tmp/prompt-dir',
                prompt: 'Special prompt text',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/prompt-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const handler = vi.fn().mockResolvedValue(undefined);
            const mod = await freshMonitor();
            mod.setMonitorTriggerHandler(handler);
            mod.initMonitors();

            fileChangeCallback!('change', 'file.txt');
            await vi.advanceTimersByTimeAsync(2100);

            const monitorArg = handler.mock.calls[0][0];
            expect(monitorArg.prompt).toBe('Special prompt text');
        });
    });

    // ── Schedule trigger ────────────────────────────────────────────

    describe('schedule trigger', () => {
        it('should trigger on interval for schedule monitors', async () => {
            const stored = [{
                id: 'mon-sched', name: 'Scheduler', description: '',
                triggerType: 'schedule', cronExpression: '*/2',
                prompt: 'Run periodic task', enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            // Advance past 2 minutes to trigger the interval
            await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 100);

            const events = mod.getMonitorEvents();
            expect(events.length).toBeGreaterThanOrEqual(1);
            expect(events[0].detail).toContain('every 2 min');
        });

        it('should default to 60 minutes for non-matching cron expressions', async () => {
            const stored = [{
                id: 'mon-default-sched', name: 'Default Sched', description: '',
                triggerType: 'schedule', cronExpression: '0 9 * * *',
                prompt: 'Daily task', enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.info).toHaveBeenCalledWith('Monitor', expect.stringContaining('every 60 minutes'));
        });

        it('should trigger multiple times after multiple intervals', async () => {
            const stored = [makeStoredMonitor({
                id: 'mon-multi-sched',
                triggerType: 'schedule',
                cronExpression: '*/1',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            // Advance 3 intervals
            await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 100);

            const events = mod.getMonitorEvents();
            expect(events.length).toBeGreaterThanOrEqual(3);
        });

        it('should call trigger handler for schedule events', async () => {
            const stored = [makeStoredMonitor({
                id: 'mon-sched-handler',
                triggerType: 'schedule',
                cronExpression: '*/1',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const handler = vi.fn().mockResolvedValue(undefined);
            const mod = await freshMonitor();
            mod.setMonitorTriggerHandler(handler);
            mod.initMonitors();

            await vi.advanceTimersByTimeAsync(1 * 60 * 1000 + 100);

            expect(handler).toHaveBeenCalledWith(
                expect.objectContaining({ id: 'mon-sched-handler' }),
                expect.objectContaining({ triggerType: 'schedule' }),
            );
        });

        it('should parse */30 as 30-minute interval', async () => {
            const stored = [makeStoredMonitor({
                id: 'mon-30min',
                triggerType: 'schedule',
                cronExpression: '*/30',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.info).toHaveBeenCalledWith('Monitor', expect.stringContaining('every 30 minutes'));

            // Should NOT trigger after only 10 minutes
            await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
            expect(mod.getMonitorEvents().length).toBe(0);

            // Should trigger after 30 minutes total
            await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 100);
            expect(mod.getMonitorEvents().length).toBeGreaterThanOrEqual(1);
        });
    });

    // ── Event log cap ───────────────────────────────────────────────

    describe('event log', () => {
        it('should cap the event log at 100 entries', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [{
                id: 'mon-cap', name: 'Cap Test', description: '',
                triggerType: 'file_change', watchPath: '/tmp/watched',
                prompt: '', enabled: true,
                createdAt: '2026-01-01T00:00:00.000Z', triggerCount: 0,
            }];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/watched') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            // Trigger 110 events — each spaced past debounce (2s) + rate limit (10s)
            for (let i = 0; i < 110; i++) {
                fileChangeCallback!('change', `file-${i}.txt`);
                await vi.advanceTimersByTimeAsync(12_100); // 2s debounce + 10s rate limit + margin
            }

            const events = mod.getMonitorEvents();
            expect(events.length).toBeLessThanOrEqual(100);
        });

        it('should keep the newest events when capped', async () => {
            let fileChangeCallback: ((eventType: string, filename: string) => void) | null = null;
            const watcher = createMockWatcher();
            mockWatch.mockImplementation((_path: string, _opts: unknown, cb: (eventType: string, filename: string) => void) => {
                fileChangeCallback = cb;
                return watcher;
            });

            const stored = [makeStoredMonitor({
                id: 'mon-newest',
                triggerType: 'file_change',
                watchPath: '/tmp/newest-dir',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/newest-dir') return true;
                if (p in mockFiles) return true;
                if (p === '/tmp/titan-test-monitor') return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            // Trigger 105 events — spaced past debounce + rate limit
            for (let i = 0; i < 105; i++) {
                fileChangeCallback!('change', `file-${i}.txt`);
                await vi.advanceTimersByTimeAsync(12_100);
            }

            const events = mod.getMonitorEvents();
            // The newest event (file-104.txt) should be at position 0
            expect(events[0].detail).toContain('file-104.txt');
        });
    });

    // ── Watcher error handling ──────────────────────────────────────

    describe('watcher error handling', () => {
        it('should log warning when file watcher emits error', async () => {
            const watcher = createMockWatcher();
            mockWatch.mockReturnValue(watcher);

            const stored = [makeStoredMonitor({
                id: 'mon-watcher-err',
                triggerType: 'file_change',
                watchPath: '/tmp/watcher-err-dir',
                enabled: true,
            })];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            mockExistsSync.mockImplementation((p: string) => {
                if (p === '/tmp/watcher-err-dir') return true;
                if (p in mockFiles) return true;
                return false;
            });

            const mod = await freshMonitor();
            mod.initMonitors();

            // Simulate watcher error
            watcher._emit('error', new Error('Permission denied'));

            const logger = (await import('../src/utils/logger.js')).default;
            expect(logger.warn).toHaveBeenCalledWith('Monitor', expect.stringContaining('File watcher error'));
        });
    });

    // ── Persistence edge cases ──────────────────────────────────────

    describe('persistence edge cases', () => {
        it('should handle empty array in monitors.json', async () => {
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify([]);

            const mod = await freshMonitor();
            const monitors = mod.listMonitors();
            expect(monitors).toEqual([]);
        });

        it('should handle monitors.json with only disabled monitors', async () => {
            const stored = [
                makeStoredMonitor({ id: 'mon-off-1', enabled: false }),
                makeStoredMonitor({ id: 'mon-off-2', enabled: false }),
            ];
            mockFiles['/tmp/titan-test-monitor/monitors.json'] = JSON.stringify(stored);

            const mod = await freshMonitor();
            mod.initMonitors();

            // No watchers or intervals should be created
            expect(mockWatch).not.toHaveBeenCalled();
        });

        it('should create directory with recursive option when saving', async () => {
            const mod = await freshMonitor();
            mod.addMonitor({
                id: 'mon-recurse',
                name: 'Recursive',
                description: '',
                triggerType: 'webhook',
                prompt: '',
                enabled: false,
            });

            expect(mockMkdirSync).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ recursive: true }),
            );
        });
    });
});
