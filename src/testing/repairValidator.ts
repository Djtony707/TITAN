/**
 * TITAN — Repair Validator
 * Lightweight validation: ensure referenced files exist and run scoped tests.
 */
import { existsSync } from 'fs';
import { runTests } from './testRunner.js';

const repairHistory: Array<{ repairId: string; timestamp: string; result: unknown }> = [];
const MAX_REPAIR_HISTORY = 200;

function pushRepairRecord(record: { repairId: string; timestamp: string; result: unknown }): void {
    pushRepairRecord(record);
    if (repairHistory.length > MAX_REPAIR_HISTORY) {
        repairHistory.splice(0, repairHistory.length - MAX_REPAIR_HISTORY);
    }
}

export function getRepairHistory(repairId?: string): unknown[] {
    if (!repairId) return repairHistory;
    return repairHistory.filter(h => h.repairId === repairId);
}

export async function validateRepair(opts: {
    repairId: string;
    finding: string;
    affectedFiles?: string[];
}): Promise<Record<string, unknown>> {
    const missing = opts.affectedFiles?.filter(f => !existsSync(f)) ?? [];
    if (missing.length > 0) {
        return { status: 'invalid', valid: false, reason: 'missing_files', missing };
    }

    const testResult = await runTests(
        opts.affectedFiles?.length ? { pattern: opts.affectedFiles.join(' ') } : undefined,
    );
    const valid = (testResult.failed as number) === 0;
    const record = {
        repairId: opts.repairId,
        timestamp: new Date().toISOString(),
        result: testResult,
    };
    repairHistory.push(record);

    return { status: valid ? 'valid' : 'invalid', valid, testResult };
}

export async function validateSystemRepair(opts: {
    repairType: string;
    target: string;
}): Promise<Record<string, unknown>> {
    const valid = existsSync(opts.target);
    return { status: valid ? 'valid' : 'invalid', valid };
}
