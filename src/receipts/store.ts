import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { mintActionId } from './mint.js';
import type { Receipt, ReceiptQuery } from './types.js';
import logger from '../utils/logger.js';

const MAX_RECEIPT_BYTES = 50 * 1024 * 1024;
const MAX_META_BYTES = 4096;
const MAX_SUMMARY_CHARS = 200;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const COMPONENT = 'Receipts';

type ReceiptDraft = Partial<Receipt> & Pick<Receipt, 'kind' | 'summary' | 'status'>;
type ReceiptSubscriber = (receipt: Receipt) => void;

const subscribers = new Set<ReceiptSubscriber>();
let lastTs = '';

function receiptPath(): string {
    const envHome = process.env.TITAN_HOME?.trim();
    if (envHome) {
        if (envHome.startsWith('~/')) return join(homedir(), envHome.slice(2), 'receipts.jsonl');
        if (envHome === '~') return join(homedir(), 'receipts.jsonl');
        return join(envHome, 'receipts.jsonl');
    }
    return join(homedir(), '.titan', 'receipts.jsonl');
}

function ensureDir(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
}

function receiptErrorCode(err: unknown): string {
    const code = typeof err === 'object' && err && 'code' in err
        ? String((err as { code?: unknown }).code)
        : 'unknown';
    return code.replace(/[^\w.-]/g, '').slice(0, 32) || 'unknown';
}

function warnReceiptError(operation: 'read' | 'write', err: unknown): void {
    try {
        logger.warn(COMPONENT, `${operation} failed (${receiptErrorCode(err)}); receipt store continuing best-effort`);
    } catch {
        /* ignore logging failures */
    }
}

function rotateIfNeeded(path: string): void {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < MAX_RECEIPT_BYTES) return;
    const rotated = join(dirname(path), `receipts-${new Date().toISOString()}.jsonl`);
    renameSync(path, rotated);
}

function normalizeMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!meta) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(meta), 'utf8');
    if (bytes <= MAX_META_BYTES) return meta;
    return { truncated: true, bytes };
}

function normalizeLimit(limit: number | undefined): number {
    if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
    return Math.min(Math.max(Math.floor(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

function matchesQuery(receipt: Receipt, q: ReceiptQuery): boolean {
    if (q.since && receipt.ts < q.since) return false;
    if (q.kind) {
        const kinds = Array.isArray(q.kind) ? q.kind : [q.kind];
        if (!kinds.includes(receipt.kind)) return false;
    }
    if (q.mission && receipt.mission !== q.mission) return false;
    if (q.agent && receipt.agent !== q.agent) return false;
    return true;
}

function nextTimestamp(candidate = new Date().toISOString()): string {
    let ts = candidate;
    if (lastTs && ts <= lastTs) {
        ts = new Date(Date.parse(lastTs) + 1).toISOString();
    }
    lastTs = ts;
    return ts;
}

export function writeReceipt(partial: ReceiptDraft): Receipt {
    const receipt: Receipt = {
        ...partial,
        action_id: partial.action_id ?? mintActionId(),
        ts: nextTimestamp(partial.ts),
        summary: partial.summary.slice(0, MAX_SUMMARY_CHARS),
        meta: normalizeMeta(partial.meta),
    };

    try {
        const path = receiptPath();
        ensureDir(path);
        rotateIfNeeded(path);
        // Receipts are intentionally tiny audit records. Synchronous append keeps
        // ordering deterministic and avoids losing the final event during process
        // exit; failures remain best-effort and never affect runtime behavior.
        appendFileSync(path, `${JSON.stringify(receipt)}\n`, 'utf8');
    } catch (err) {
        warnReceiptError('write', err);
        return receipt;
    }

    for (const fn of subscribers) {
        try {
            fn(receipt);
        } catch {
            /* subscribers must not affect receipt writes */
        }
    }

    return receipt;
}

export function readReceipts(q: ReceiptQuery = {}): Receipt[] {
    const path = receiptPath();
    const limit = normalizeLimit(q.limit);
    if (!existsSync(path)) return [];

    try {
        const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
        const receipts: Receipt[] = [];
        for (let i = lines.length - 1; i >= 0 && receipts.length < limit; i--) {
            try {
                const receipt = JSON.parse(lines[i]!) as Receipt;
                if (matchesQuery(receipt, q)) receipts.push(receipt);
            } catch {
                /* skip malformed lines */
            }
        }
        return receipts;
    } catch (err) {
        warnReceiptError('read', err);
        return [];
    }
}

export function subscribeReceipts(fn: ReceiptSubscriber): () => void {
    subscribers.add(fn);
    return () => {
        subscribers.delete(fn);
    };
}
