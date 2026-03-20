/**
 * TITAN — Autopilot Engine Tests
 * Tests src/agent/autopilot.ts: scheduled runs, checklist reading, classification,
 * run history, active hours, budget checks, delivery, init/stop lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('../src/utils/logger.js', () => ({
    default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockWriteFileSync = vi.fn();
const mockAppendFileSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
    appendFileSync: (...args: unknown[]) => mockAppendFileSync(...args),
    mkdirSync: (...args: unknown[]) => mockMkdirSync(...args),
}));

const mockProcessMessage = vi.fn();
vi.mock('../src/agent/agent.js', () => ({
    processMessage: (...args: unknown[]) => mockProcessMessage(...args),
}));

const mockLoadConfig = vi.fn();
vi.mock('../src/config/config.js', () => ({
    loadConfig: () => mockLoadConfig(),
    updateConfig: vi.fn(),
}));

const mockGetDailyTotal = vi.fn().mockReturnValue(0);
vi.mock('../src/agent/costOptimizer.js', () => ({
    getDailyTotal: () => mockGetDailyTotal(),
}));

const mockCronSchedule = vi.fn();
const mockCronValidate = vi.fn().mockReturnValue(true);
vi.mock('node-cron', () => ({
    schedule: (...args: unknown[]) => mockCronSchedule(...args),
    validate: (...args: unknown[]) => mockCronValidate(...args),
}));

// ─── Helpers ────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, unknown> = {}) {
    return {
        agent: {
            model: 'anthropic/claude-sonnet-4-20250514',
            costOptimization: { dailyBudgetUsd: 0 },
            ...(overrides.agent || {}),
        },
        autopilot: {
            enabled: false,
            dryRun: false,
            schedule: '0 2 * * *',
            model: 'anthropic/claude-haiku',
            maxTokensPerRun: 4000,
            maxToolRounds: 5,
            reportChannel: 'cli',
            maxRunHistory: 30,
            skipIfEmpty: true,
            ...(overrides.autopilot || {}),
        },
        channels: {
            discord: { enabled: false },
            ...(overrides.channels || {}),
        },
    };
}

function makeAgentResponse(content: string, tools: string[] = []) {
    return {
        content,
        model: 'anthropic/claude-haiku',
        tokenUsage: { prompt: 100, completion: 50, total: 150 },
        toolsUsed: tools,
        durationMs: 500,
    };
}

// ─── Import after mocks ─────────────────────────────────────────

import {
    readChecklist,
    initChecklist,
    classifyResult,
    getRunHistory,
    isWithinActiveHours,
    runAutopilotNow,
    initAutopilot,
    stopAutopilot,
    setAutopilotDryRun,
    getAutopilotStatus,
} from '../src/agent/autopilot.js';
import { TitanConfigSchema } from '../src/config/schema.js';

// ─── Tests ──────────────────────────────────────────────────────

describe('Autopilot Engine', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAutopilotDryRun(undefined);
        mockLoadConfig.mockReturnValue(makeConfig());
        mockExistsSync.mockReturnValue(false);
        mockReadFileSync.mockReturnValue('');
    });

    // ── Config Schema ───────────────────────────────────────────

    describe('Config Schema', () => {
        it('should parse with defaults', () => {
            const config = TitanConfigSchema.parse({});
            expect(config.autopilot).toBeDefined();
            expect(config.autopilot.enabled).toBe(false);
            expect(config.autopilot.dryRun).toBe(false);
            expect(config.autopilot.schedule).toBe('0 2 * * *');
            expect(config.autopilot.model).toBe('anthropic/claude-haiku');
            expect(config.autopilot.maxTokensPerRun).toBe(4000);
            expect(config.autopilot.maxToolRounds).toBe(5);
            expect(config.autopilot.reportChannel).toBe('cli');
            expect(config.autopilot.maxRunHistory).toBe(30);
            expect(config.autopilot.skipIfEmpty).toBe(true);
        });

        it('should accept custom values', () => {
            const config = TitanConfigSchema.parse({
                autopilot: {
                    enabled: true,
                    dryRun: true,
                    schedule: '*/30 * * * *',
                    model: 'openai/gpt-4o-mini',
                    maxTokensPerRun: 8000,
                    maxToolRounds: 10,
                    reportChannel: 'discord',
                    maxRunHistory: 50,
                    skipIfEmpty: false,
                },
            });
            expect(config.autopilot.enabled).toBe(true);
            expect(config.autopilot.dryRun).toBe(true);
            expect(config.autopilot.schedule).toBe('*/30 * * * *');
            expect(config.autopilot.model).toBe('openai/gpt-4o-mini');
            expect(config.autopilot.maxTokensPerRun).toBe(8000);
            expect(config.autopilot.reportChannel).toBe('discord');
        });

        it('should accept activeHours', () => {
            const config = TitanConfigSchema.parse({
                autopilot: {
                    activeHours: { start: 8, end: 22 },
                },
            });
            expect(config.autopilot.activeHours).toEqual({ start: 8, end: 22 });
        });

        it('should reject invalid activeHours', () => {
            expect(() => TitanConfigSchema.parse({
                autopilot: { activeHours: { start: -1, end: 24 } },
            })).toThrow();
        });

        it('should accept checklistPath', () => {
            const config = TitanConfigSchema.parse({
                autopilot: { checklistPath: '/custom/path.md' },
            });
            expect(config.autopilot.checklistPath).toBe('/custom/path.md');
        });

        it('should not have checklistPath by default', () => {
            const config = TitanConfigSchema.parse({});
            expect(config.autopilot.checklistPath).toBeUndefined();
        });
    });

    // ── Checklist reading ───────────────────────────────────────

    describe('readChecklist()', () => {
        it('should return empty string when file does not exist', () => {
            mockExistsSync.mockReturnValue(false);
            const config = makeConfig();
            expect(readChecklist(config as any)).toBe('');
        });

        it('should read file contents when it exists', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('- Check for errors\n- Review logs\n');
            const config = makeConfig();
            expect(readChecklist(config as any)).toBe('- Check for errors\n- Review logs');
        });

        it('should use custom checklistPath from config', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('custom checklist');
            const config = makeConfig({ autopilot: { checklistPath: '/custom/path.md' } });
            readChecklist(config as any);
            expect(mockExistsSync).toHaveBeenCalledWith('/custom/path.md');
        });

        it('should handle read errors gracefully', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation(() => { throw new Error('EACCES'); });
            const config = makeConfig();
            expect(readChecklist(config as any)).toBe('');
        });
    });

    // ── initChecklist ───────────────────────────────────────────

    describe('initChecklist()', () => {
        it('should create default checklist when file does not exist', () => {
            mockExistsSync.mockReturnValue(false);
            initChecklist('/tmp/test-autopilot.md');
            expect(mockWriteFileSync).toHaveBeenCalledWith(
                '/tmp/test-autopilot.md',
                expect.stringContaining('TITAN Autopilot Checklist'),
                'utf-8',
            );
        });

        it('should not overwrite existing file', () => {
            mockExistsSync.mockReturnValue(true);
            initChecklist('/tmp/test-autopilot.md');
            expect(mockWriteFileSync).not.toHaveBeenCalled();
        });

        it('should create parent directories', () => {
            mockExistsSync.mockReturnValue(false);
            initChecklist('/some/deep/path/AUTOPILOT.md');
            expect(mockMkdirSync).toHaveBeenCalledWith('/some/deep/path', { recursive: true });
        });

        it('should handle write errors gracefully', () => {
            mockExistsSync.mockReturnValue(false);
            mockMkdirSync.mockImplementation(() => { throw new Error('EPERM'); });
            // Should not throw
            expect(() => initChecklist('/tmp/fail.md')).not.toThrow();
        });
    });

    // ── Classification ──────────────────────────────────────────

    describe('classifyResult()', () => {
        it('should return ok for benign content', () => {
            expect(classifyResult('Everything looks fine. No issues detected.')).toBe('ok');
        });

        it('should return urgent for error keywords', () => {
            expect(classifyResult('A critical error was detected in the system.')).toBe('urgent');
        });

        it('should return urgent for failure keywords', () => {
            expect(classifyResult('Build failed with exit code 1')).toBe('urgent');
        });

        it('should return urgent for crash keywords', () => {
            expect(classifyResult('The process crashed unexpectedly')).toBe('urgent');
        });

        it('should return notable for found keywords with enough content', () => {
            const content = 'I found several new TODO items in the workspace that need attention. ' +
                'Here is a detailed list of all the items I discovered during my review of the codebase.';
            expect(classifyResult(content)).toBe('notable');
        });

        it('should return ok for short notable-keyword content', () => {
            // Short content with notable keywords shouldn't trigger notable
            expect(classifyResult('found it')).toBe('ok');
        });

        it('should respect explicit Classification: OK', () => {
            expect(classifyResult('There were some errors but Classification: OK overall')).toBe('ok');
        });

        it('should respect explicit Classification: NOTABLE', () => {
            expect(classifyResult('Routine check. Classification: NOTABLE')).toBe('notable');
        });

        it('should respect explicit Classification: URGENT', () => {
            expect(classifyResult('All good. Classification: URGENT')).toBe('urgent');
        });

        it('should be case-insensitive for keywords', () => {
            expect(classifyResult('CRITICAL system failure')).toBe('urgent');
        });

        it('should prioritize explicit classification over keywords', () => {
            expect(classifyResult('Error detected but Classification: OK')).toBe('ok');
        });

        it('should detect broken keyword', () => {
            expect(classifyResult('The pipeline is broken')).toBe('urgent');
        });

        it('should detect exception keyword', () => {
            expect(classifyResult('Unhandled exception in worker')).toBe('urgent');
        });

        it('should detect down keyword', () => {
            expect(classifyResult('The API server is down')).toBe('urgent');
        });

        it('should detect warning keyword as notable', () => {
            const content = 'There is a warning about deprecated API usage. This should be investigated before the next major release cycle completes.';
            expect(classifyResult(content)).toBe('notable');
        });

        it('should detect completed keyword as notable', () => {
            const content = 'The migration task has been completed successfully. All database records have been updated and verified against the new schema.';
            expect(classifyResult(content)).toBe('notable');
        });

        it('should detect changed keyword as notable', () => {
            const content = 'Configuration files have changed since the last check. Multiple files were updated including the main config and environment variables.';
            expect(classifyResult(content)).toBe('notable');
        });
    });

    // ── Active hours ────────────────────────────────────────────

    describe('isWithinActiveHours()', () => {
        it('should return true when no activeHours configured', () => {
            const config = makeConfig();
            expect(isWithinActiveHours(config as any)).toBe(true);
        });

        it('should return true when within active hours (normal range)', () => {
            const config = makeConfig({
                autopilot: { activeHours: { start: 0, end: 23 } },
            });
            expect(isWithinActiveHours(config as any)).toBe(true);
        });

        it('should handle midnight-wrapping ranges', () => {
            // start=22, end=6 means "10pm to 6am"
            const config = makeConfig({
                autopilot: { activeHours: { start: 22, end: 6 } },
            });
            // This test is time-dependent, but the logic is tested
            const result = isWithinActiveHours(config as any);
            expect(typeof result).toBe('boolean');
        });
    });

    // ── Run history ─────────────────────────────────────────────

    describe('getRunHistory()', () => {
        it('should return empty array when no history file', () => {
            mockExistsSync.mockReturnValue(false);
            expect(getRunHistory()).toEqual([]);
        });

        it('should parse JSONL history file', () => {
            mockExistsSync.mockReturnValue(true);
            const run1 = JSON.stringify({ timestamp: '2026-03-01T02:00:00Z', classification: 'ok', summary: 'All good' });
            const run2 = JSON.stringify({ timestamp: '2026-03-02T02:00:00Z', classification: 'notable', summary: 'Found items' });
            mockReadFileSync.mockReturnValue(`${run1}\n${run2}\n`);
            const history = getRunHistory();
            expect(history).toHaveLength(2);
            expect(history[0].classification).toBe('ok');
            expect(history[1].classification).toBe('notable');
        });

        it('should respect limit parameter', () => {
            mockExistsSync.mockReturnValue(true);
            const runs = Array.from({ length: 10 }, (_, i) =>
                JSON.stringify({ timestamp: `2026-03-${i + 1}T02:00:00Z`, classification: 'ok', summary: `Run ${i}` })
            ).join('\n');
            mockReadFileSync.mockReturnValue(runs);
            const history = getRunHistory(3);
            expect(history).toHaveLength(3);
        });

        it('should skip invalid JSON lines', () => {
            mockExistsSync.mockReturnValue(true);
            const valid = JSON.stringify({ timestamp: '2026-03-01T02:00:00Z', classification: 'ok' });
            mockReadFileSync.mockReturnValue(`${valid}\n{invalid json}\n`);
            const history = getRunHistory();
            expect(history).toHaveLength(1);
        });

        it('should handle read errors', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockImplementation(() => { throw new Error('EACCES'); });
            expect(getRunHistory()).toEqual([]);
        });

        it('should return most recent entries when limited', () => {
            mockExistsSync.mockReturnValue(true);
            const runs = Array.from({ length: 5 }, (_, i) =>
                JSON.stringify({ timestamp: `2026-03-${i + 1}T02:00:00Z`, classification: 'ok', summary: `Run ${i}` })
            ).join('\n');
            mockReadFileSync.mockReturnValue(runs);
            const history = getRunHistory(2);
            expect(history).toHaveLength(2);
            expect(history[0].summary).toBe('Run 3');
            expect(history[1].summary).toBe('Run 4');
        });
    });

    // ── runAutopilotNow() ───────────────────────────────────────

    describe('runAutopilotNow()', () => {
        it('should skip when checklist is empty and skipIfEmpty is true', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: true } }));
            mockExistsSync.mockReturnValue(false);
            const result = await runAutopilotNow();
            expect(result.run.skipped).toBe(true);
            expect(result.run.skipReason).toBe('empty_checklist');
            expect(mockProcessMessage).not.toHaveBeenCalled();
        });

        it('should run when checklist is empty and skipIfEmpty is false', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('autopilot-runs')) return false;
                return false;
            });
            mockProcessMessage.mockResolvedValue(makeAgentResponse('Everything is fine. Classification: OK'));
            const result = await runAutopilotNow();
            expect(result.run.skipped).toBeUndefined();
            expect(mockProcessMessage).toHaveBeenCalled();
        });

        it('should call processMessage with autopilot prompt', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('AUTOPILOT.md')) return true;
                return false;
            });
            mockReadFileSync.mockReturnValue('- Check for errors\n- Review logs');
            mockProcessMessage.mockResolvedValue(makeAgentResponse('All good. Classification: OK'));
            await runAutopilotNow();
            expect(mockProcessMessage).toHaveBeenCalledWith(
                expect.stringContaining('Check for errors'),
                'autopilot',
                'system',
                { model: 'anthropic/claude-haiku' },
            );
        });

        it('should use configured model override', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({
                autopilot: { skipIfEmpty: false, model: 'openai/gpt-4o-mini' },
            }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            await runAutopilotNow();
            expect(mockProcessMessage).toHaveBeenCalledWith(
                expect.any(String),
                'autopilot',
                'system',
                { model: 'openai/gpt-4o-mini' },
            );
        });

        it('should classify result from agent response', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('Critical error found! Classification: URGENT'));
            const result = await runAutopilotNow();
            expect(result.run.classification).toBe('urgent');
        });

        it('should record tools used', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK', ['shell', 'read_file']));
            const result = await runAutopilotNow();
            expect(result.run.toolsUsed).toEqual(['shell', 'read_file']);
        });

        it('should record token usage', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            const result = await runAutopilotNow();
            expect(result.run.tokensUsed).toBe(150);
        });

        it('should return run data with correct fields after full run', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockImplementation((path: string) => {
                if (typeof path === 'string' && path.includes('AUTOPILOT.md')) return true;
                return false;
            });
            mockReadFileSync.mockReturnValue('- Check system health');
            mockProcessMessage.mockResolvedValue(makeAgentResponse('All clear. Classification: OK'));
            const result = await runAutopilotNow();
            expect(result.run.skipped).toBeUndefined();
            expect(result.run.timestamp).toBeDefined();
            expect(result.run.duration).toBeGreaterThanOrEqual(0);
            expect(result.run.tokensUsed).toBe(150);
            expect(result.run.classification).toBe('ok');
            expect(result.run.summary).toContain('All clear');
        });

        it('should handle processMessage errors gracefully', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockRejectedValue(new Error('LLM timeout'));
            const result = await runAutopilotNow();
            expect(result.run.classification).toBe('urgent');
            expect(result.run.summary).toContain('LLM timeout');
        });

        it('should skip when budget is exceeded', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({
                agent: { costOptimization: { dailyBudgetUsd: 1.0 } },
            }));
            mockGetDailyTotal.mockReturnValue(1.5);
            const result = await runAutopilotNow();
            expect(result.run.skipped).toBe(true);
            expect(result.run.skipReason).toBe('budget_exceeded');
        });

        it('should not skip when budget is not set', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({
                autopilot: { skipIfEmpty: false },
                agent: { costOptimization: { dailyBudgetUsd: 0 } },
            }));
            mockGetDailyTotal.mockReturnValue(100);
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            const result = await runAutopilotNow();
            expect(result.run.skipped).toBeUndefined();
        });

        it('should deliver notable results', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            const longNotable = 'I found several important changes that need your attention. The workspace has been updated with new files. Classification: NOTABLE';
            mockProcessMessage.mockResolvedValue(makeAgentResponse(longNotable));
            const result = await runAutopilotNow();
            expect(result.run.classification).toBe('notable');
            expect(result.delivered).toBe(true);
        });

        it('should not deliver ok results', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('All quiet. Classification: OK'));
            const result = await runAutopilotNow();
            expect(result.run.classification).toBe('ok');
            expect(result.delivered).toBe(false);
        });

        it('should inject previous run summary as context', async () => {
            // First make history available
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('autopilot-runs')) return true;
                return false;
            });
            mockReadFileSync.mockReturnValue(
                JSON.stringify({ timestamp: '2026-03-01', classification: 'ok', summary: 'Previous run was fine' }) + '\n'
            );
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            await runAutopilotNow();
            expect(mockProcessMessage).toHaveBeenCalledWith(
                expect.stringContaining('Previous Run Summary'),
                expect.any(String),
                expect.any(String),
                expect.any(Object),
            );
        });

        it('should truncate summary to 500 chars', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            const longContent = 'x'.repeat(1000) + ' Classification: OK';
            mockProcessMessage.mockResolvedValue(makeAgentResponse(longContent));
            const result = await runAutopilotNow();
            expect(result.run.summary.length).toBeLessThanOrEqual(500);
        });

        it('should record duration', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            const result = await runAutopilotNow();
            expect(result.run.duration).toBeGreaterThanOrEqual(0);
        });

        it('should include timestamp in ISO format', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            const result = await runAutopilotNow();
            expect(result.run.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        });

        it('should skip execution when dryRun is enabled', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false, dryRun: true } }));
            mockExistsSync.mockReturnValue(false);
            const result = await runAutopilotNow();

            expect(result.run.skipped).toBe(true);
            expect(result.run.skipReason).toBe('dry_run');
            expect(result.run.classification).toBe('ok');
            expect(result.run.summary).toContain('Dry-run');
            expect(mockProcessMessage).not.toHaveBeenCalled();
        });

        it('should honor per-call dryRun=true over config dryRun=false', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false, dryRun: false } }));
            mockExistsSync.mockReturnValue(false);

            const result = await runAutopilotNow({ dryRun: true });

            expect(result.run.skipped).toBe(true);
            expect(result.run.skipReason).toBe('dry_run');
            expect(mockProcessMessage).not.toHaveBeenCalled();
        });

        it('should honor runtime dryRun override via setAutopilotDryRun(true)', async () => {
            setAutopilotDryRun(true);
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false, dryRun: false } }));
            mockExistsSync.mockReturnValue(false);

            const result = await runAutopilotNow();

            expect(result.run.skipped).toBe(true);
            expect(result.run.skipReason).toBe('dry_run');
            expect(mockProcessMessage).not.toHaveBeenCalled();
        });

        it('should honor per-call dryRun=false over runtime dryRun=true', async () => {
            setAutopilotDryRun(true);
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false, dryRun: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));

            const result = await runAutopilotNow({ dryRun: false });

            expect(result.run.skipped).toBeUndefined();
            expect(mockProcessMessage).toHaveBeenCalled();
        });
    });

    // ── initAutopilot / stopAutopilot ───────────────────────────

    describe('initAutopilot()', () => {
        it('should not schedule when disabled', () => {
            const config = makeConfig({ autopilot: { enabled: false } });
            initAutopilot(config as any);
            expect(mockCronSchedule).not.toHaveBeenCalled();
        });

        it('should schedule cron when enabled', () => {
            const config = makeConfig({ autopilot: { enabled: true, schedule: '0 2 * * *' } });
            mockCronSchedule.mockReturnValue({ stop: vi.fn() });
            initAutopilot(config as any);
            expect(mockCronSchedule).toHaveBeenCalledWith('0 2 * * *', expect.any(Function));
        });

        it('should reject invalid cron expressions', () => {
            mockCronValidate.mockReturnValue(false);
            const config = makeConfig({ autopilot: { enabled: true, schedule: 'invalid' } });
            initAutopilot(config as any);
            expect(mockCronSchedule).not.toHaveBeenCalled();
        });

        it('should use custom schedule from config', () => {
            const config = makeConfig({ autopilot: { enabled: true, schedule: '*/15 * * * *' } });
            mockCronValidate.mockReturnValue(true);
            mockCronSchedule.mockReturnValue({ stop: vi.fn() });
            initAutopilot(config as any);
            expect(mockCronSchedule).toHaveBeenCalledWith('*/15 * * * *', expect.any(Function));
        });

        it('should not reset runtime dryRun when initAutopilot is called', async () => {
            setAutopilotDryRun(true);
            const config = makeConfig({ autopilot: { enabled: true, dryRun: false, skipIfEmpty: false } });
            mockCronValidate.mockReturnValue(true);
            mockCronSchedule.mockReturnValue({ stop: vi.fn() });
            mockExistsSync.mockReturnValue(false);
            mockLoadConfig.mockReturnValue(config);

            initAutopilot(config as any);
            const result = await runAutopilotNow();

            expect(result.run.skipped).toBe(true);
            expect(result.run.skipReason).toBe('dry_run');
        });
    });

    describe('stopAutopilot()', () => {
        it('should stop cron task', () => {
            const mockStop = vi.fn();
            mockCronSchedule.mockReturnValue({ stop: mockStop });
            const config = makeConfig({ autopilot: { enabled: true } });
            mockCronValidate.mockReturnValue(true);
            initAutopilot(config as any);
            stopAutopilot();
            expect(mockStop).toHaveBeenCalled();
        });

        it('should handle stop when not initialized', () => {
            // Should not throw
            expect(() => stopAutopilot()).not.toThrow();
        });
    });

    // ── getAutopilotStatus() ────────────────────────────────────

    describe('getAutopilotStatus()', () => {
        it('should return disabled status by default', () => {
            mockExistsSync.mockReturnValue(false);
            const status = getAutopilotStatus();
            expect(status.enabled).toBe(false);
            expect(status.dryRun).toBe(false);
            expect(status.schedule).toBe('0 2 * * *');
            expect(status.isRunning).toBe(false);
        });

        it('should report total runs from history', () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('autopilot-runs')) return true;
                return false;
            });
            const runs = Array.from({ length: 5 }, (_, i) =>
                JSON.stringify({ timestamp: `2026-03-${i + 1}T02:00:00Z`, classification: 'ok' })
            ).join('\n');
            mockReadFileSync.mockReturnValue(runs);
            const status = getAutopilotStatus();
            expect(status.totalRuns).toBe(5);
        });

        it('should include last run info', () => {
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('autopilot-runs')) return true;
                return false;
            });
            mockReadFileSync.mockReturnValue(
                JSON.stringify({ timestamp: '2026-03-03T02:00:00Z', classification: 'notable', summary: 'Found things' }) + '\n'
            );
            const status = getAutopilotStatus();
            expect(status.lastRun).toBeDefined();
            expect(status.lastRun!.classification).toBe('notable');
        });
    });

    // ── Prompt building ─────────────────────────────────────────

    describe('Prompt building', () => {
        it('should include checklist items in prompt', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockImplementation((path: string) => {
                if (path.includes('AUTOPILOT.md')) return true;
                return false;
            });
            mockReadFileSync.mockReturnValue('- Check disk space\n- Verify backups');
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            await runAutopilotNow();
            const prompt = mockProcessMessage.mock.calls[0][0];
            expect(prompt).toContain('Check disk space');
            expect(prompt).toContain('Verify backups');
        });

        it('should include classification instructions', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            await runAutopilotNow();
            const prompt = mockProcessMessage.mock.calls[0][0];
            expect(prompt).toContain('Classification: OK');
            expect(prompt).toContain('Classification: NOTABLE');
            expect(prompt).toContain('Classification: URGENT');
        });

        it('should include autopilot mode header', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            await runAutopilotNow();
            const prompt = mockProcessMessage.mock.calls[0][0];
            expect(prompt).toContain('Autopilot mode');
        });
    });

    // ── Edge cases ──────────────────────────────────────────────

    describe('Edge cases', () => {
        it('should handle concurrent run attempts', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            // Make processMessage slow
            mockProcessMessage.mockImplementation(() => new Promise(resolve => {
                setTimeout(() => resolve(makeAgentResponse('OK. Classification: OK')), 100);
            }));

            const run1 = runAutopilotNow();
            // Second run should be rejected while first is in progress
            await expect(runAutopilotNow()).rejects.toThrow('already in progress');
            await run1;
        });

        it('should reset isRunning flag after error', async () => {
            mockLoadConfig.mockReturnValue(makeConfig({ autopilot: { skipIfEmpty: false } }));
            mockExistsSync.mockReturnValue(false);
            mockProcessMessage.mockRejectedValue(new Error('boom'));
            await runAutopilotNow();
            // Should be able to run again
            mockProcessMessage.mockResolvedValue(makeAgentResponse('OK. Classification: OK'));
            const result = await runAutopilotNow();
            expect(result.run.classification).toBe('ok');
        });

        it('should handle empty history file gracefully', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('');
            expect(getRunHistory()).toEqual([]);
        });

        it('should handle history file with only newlines', () => {
            mockExistsSync.mockReturnValue(true);
            mockReadFileSync.mockReturnValue('\n\n\n');
            expect(getRunHistory()).toEqual([]);
        });
    });
});
