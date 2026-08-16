/**
 * TITAN — Company brain: v7-history seeding (v8 Slice 7, Part 3)
 *
 * One-shot import of recent v7 history — receipts (`receipts/store.ts`) and
 * persisted execution traces (`agent/traceStore.ts`) — into the company
 * brain (`brain.ts`) as `user`-attributed `brain.entry` observations. This
 * is how a workspace that already has v7 history gets a non-empty brain on
 * first company boot, without fabricating attribution: everything imported
 * is signed by `user`, the one principal who legitimately owns pre-company
 * history.
 *
 * Events are truth (council ruling, brain.ts): this module only APPENDS
 * `brain.entry` events through the normal signed store API
 * (`appendBrainEntry`) — it does not touch brain.db directly. Idempotency
 * is achieved the same way any other replay-safe importer would: fold the
 * log first, and skip anything that was already imported.
 *
 * IDENTITY & IDEMPOTENCY: every imported entry carries a third tag,
 * `src:<id>` — the receipt's `action_id` or the trace's `traceId` — as a
 * deterministic identity marker. Before importing, the existing (non-
 * tombstoned) brain entries are folded and their `src:*` tags collected;
 * an item whose src tag is already present is skipped. Re-running this
 * function against the same v7 history is therefore a no-op.
 */
import { join } from 'path';
import type { KeyObject } from 'crypto';
import type { CompanyLog } from './log.js';
import { appendBrainEntry, foldBrain, BRAIN_MAX_TEXT } from './brain.js';
import { loadAgentKeys } from './keys.js';
import { readReceipts } from '../receipts/store.js';
import type { Receipt } from '../receipts/types.js';
import { readTraces } from '../agent/traceStore.js';
import type { PersistedTrace } from '../agent/traceStore.js';
import logger from '../utils/logger.js';

const COMPONENT = 'BrainSeed';

/** Per-source read cap (spec: default 100, hard max 500). */
const DEFAULT_LIMIT_PER_SOURCE = 100;
const MAX_LIMIT_PER_SOURCE = 500;

/** Mirrors brain.ts's validator per-tag length cap (64 chars; not exported
 *  there as a constant — kept in sync manually, same as its BRAIN_MAX_TAGS
 *  sibling). */
const SRC_TAG_MAX_LEN = 64;

export interface SeedBrainOptions {
    /** Max items read per source (receipts, traces). Default 100, hard max 500. */
    limit?: number;
}

export interface SeedBrainResult {
    /** brain.entry events newly appended this run. */
    imported: number;
    /** Items skipped: already imported (idempotency) or malformed/empty. */
    skipped: number;
}

function resolveLimit(limit: number | undefined): number {
    if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT_PER_SOURCE;
    return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT_PER_SOURCE);
}

/** Truncate to the brain.entry text cap (brain.ts BRAIN_MAX_TEXT). Imported
 *  directly from brain.ts so the two can never drift. */
function truncateText(text: string): string {
    return text.length > BRAIN_MAX_TEXT ? text.slice(0, BRAIN_MAX_TEXT) : text;
}

/**
 * Deterministic identity tag for one v7 item, truncated to the tag length
 * cap if the source id is unusually long (spec: "truncate the src tag
 * payload if needed"). A truncated collision between two distinct
 * unusually-long ids is a theoretical risk we accept, same as any
 * fixed-width identifier truncation.
 */
function srcTag(id: string): string {
    const tag = `src:${id}`;
    return tag.length > SRC_TAG_MAX_LEN ? tag.slice(0, SRC_TAG_MAX_LEN) : tag;
}

interface SeedCandidate {
    /** The second brain.entry tag, by source. */
    sourceTag: 'receipt' | 'trace';
    srcTag: string;
    text: string;
}

/** Build the candidate brain.entry for one receipt, or null to skip
 *  (empty summary, missing action_id, or already imported). Never throws:
 *  every field access is guarded, since receipts are read from disk and
 *  may not match the Receipt shape at runtime. */
function receiptCandidate(raw: unknown, existingSrcTags: ReadonlySet<string>): SeedCandidate | null {
    const r = raw as Partial<Receipt> | null | undefined;
    const summary = typeof r?.summary === 'string' ? r.summary.trim() : '';
    if (!summary) return null;
    const actionId = typeof r?.action_id === 'string' ? r.action_id : '';
    if (!actionId) return null;
    const tag = srcTag(actionId);
    if (existingSrcTags.has(tag)) return null;
    const kind = typeof r?.kind === 'string' ? r.kind : 'unknown';
    const status = typeof r?.status === 'string' ? r.status : 'unknown';
    return { sourceTag: 'receipt', srcTag: tag, text: truncateText(`${kind} ${status}: ${summary}`) };
}

/** Build the candidate brain.entry for one persisted trace, or null to
 *  skip (empty message, missing traceId, or already imported). Never
 *  throws — same guarded-access discipline as receiptCandidate. */
function traceCandidate(raw: unknown, existingSrcTags: ReadonlySet<string>): SeedCandidate | null {
    const t = raw as Partial<PersistedTrace> | null | undefined;
    const message = typeof t?.message === 'string' ? t.message.trim() : '';
    if (!message) return null;
    const traceId = typeof t?.traceId === 'string' ? t.traceId : '';
    if (!traceId) return null;
    const tag = srcTag(traceId);
    if (existingSrcTags.has(tag)) return null;
    const toolCallCount = Array.isArray(t?.toolCalls) ? t.toolCalls.length : 0;
    const status = typeof t?.status === 'string' ? t.status : 'unknown';
    return {
        sourceTag: 'trace',
        srcTag: tag,
        text: truncateText(`task: ${message} (${toolCallCount} tool calls, ${status})`),
    };
}

/** Append one candidate as `user` and record its src tag so later items in
 *  the same run see it as already-imported too. */
function importCandidate(
    log: CompanyLog,
    userPrivateKey: KeyObject,
    candidate: SeedCandidate,
    existingSrcTags: Set<string>,
): void {
    appendBrainEntry(log, 'user', userPrivateKey, {
        entryKind: 'observation',
        text: candidate.text,
        scope: 'company',
        tags: ['legacy-v7', candidate.sourceTag, candidate.srcTag],
    });
    existingSrcTags.add(candidate.srcTag);
}

/**
 * One-shot import of recent v7 history (receipts + persisted traces) into
 * the company brain, attributed to `user`. Reads from `titanHome` via the
 * receipts/trace stores (which resolve TITAN_HOME at call time) and
 * appends through `log` — a brain-mode (`{ brain: true }`) CompanyLog for
 * the same home. Idempotent and never throws on a malformed individual
 * item; see module docs.
 */
export function seedBrainFromV7(
    titanHome: string,
    log: CompanyLog,
    opts: SeedBrainOptions = {},
): SeedBrainResult {
    const limit = resolveLimit(opts.limit);
    const keysDir = join(titanHome, 'company', 'keys');
    const userKey = loadAgentKeys('user', keysDir);

    // Fold once up front: the identity-tag membership check is against
    // state as of the start of this run (events appended during this run
    // are tracked in the local `existingSrcTags` set below, not re-folded).
    const fold = foldBrain(log.readAll());
    const existingSrcTags = new Set<string>();
    for (const entry of fold.entries.values()) {
        if (entry.tombstoned) continue;
        for (const tag of entry.tags) {
            if (tag.startsWith('src:')) existingSrcTags.add(tag);
        }
    }

    let imported = 0;
    let skipped = 0;

    let receipts: readonly unknown[] = [];
    try {
        receipts = readReceipts({ limit });
    } catch (err) {
        logger.warn(COMPONENT, `readReceipts failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const raw of receipts) {
        try {
            const candidate = receiptCandidate(raw, existingSrcTags);
            if (!candidate) { skipped += 1; continue; }
            importCandidate(log, userKey.privateKey, candidate, existingSrcTags);
            imported += 1;
        } catch (err) {
            logger.warn(COMPONENT, `skipped a malformed receipt: ${err instanceof Error ? err.message : String(err)}`);
            skipped += 1;
        }
    }

    let traces: readonly unknown[] = [];
    try {
        traces = readTraces(limit);
    } catch (err) {
        logger.warn(COMPONENT, `readTraces failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const raw of traces) {
        try {
            const candidate = traceCandidate(raw, existingSrcTags);
            if (!candidate) { skipped += 1; continue; }
            importCandidate(log, userKey.privateKey, candidate, existingSrcTags);
            imported += 1;
        } catch (err) {
            logger.warn(COMPONENT, `skipped a malformed trace: ${err instanceof Error ? err.message : String(err)}`);
            skipped += 1;
        }
    }

    return { imported, skipped };
}
