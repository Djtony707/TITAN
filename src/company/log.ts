/**
 * TITAN — Company event log (v8 Slice 1)
 *
 * Company-specific wrapper over the feature-neutral signed event log
 * substrate (src/substrate/eventLog.ts). Per the v8 architecture baseline
 * (Claude ruling ef548f79, Honey design verdict 77eedd22), the signed event
 * log is substrate, not a company feature. This module provides Company's
 * kinds, authority table, key management, and queue-specific methods on
 * top of the SystemStore coordinator and its branded FeatureCapability.
 *
 * Trust model (unchanged from original Slice 1, event 56c3dd16):
 *  - Actor binding: append() derives the public key from the supplied
 *    private key and requires it to MATCH the actor's registered public
 *    key on disk. No key can sign as another actor.
 *  - Authority: privileged event kinds are restricted per actor role
 *    (slice 1: company.created / agent.minted are user-only; delegation
 *    and checks are CEO-or-user).
 *  - Envelope binding: signatures cover id | prev_hash | kind | ts |
 *    actor | payload. prev_hash chains each event to its predecessor
 *    (sha256 of the previous row's sig+id; 'genesis' for the first), so
 *    rows cannot be re-identified, reordered, or spliced without breaking
 *    verification. verifyChain() walks the whole log.
 *  - Verification reads ONLY stored rows (verifyEvent takes an event id;
 *    caller-supplied fields are never trusted).
 *  - Publication rides the guarded substrate emit (same titanEvents
 *    emitter, exception-safe): a throwing subscriber can never make a
 *    persisted append look failed (no duplicate-on-retry).
 *  - Append-only: no update/delete API exists.
 *
 * Runtime floor: node:sqlite runs unflagged on Node >= 22.13.0. The
 * import of this module is gated by src/company/compat.ts (the company
 * layer refuses to activate below the floor); package `engines` stays at
 * the v7 floor because the flag-off product must keep supporting it.
 */
import type { KeyObject } from 'crypto';
import { createPublicKey } from 'crypto';
import {
    SystemStore,
    type FeatureCapability,
    type SystemEvent,
    type SystemAppendContext,
    type SystemLifecycleValidator,
    type SigningContext,
    type FeatureRegistration,
} from '../substrate/eventLog.js';
import { signBytes, verifyBytes, loadAgentPublicKey, samePublicKey, assertValidAgentId } from './keys.js';
import { emit as busEmit, type CompanyEventPayload } from '../substrate/traceBus.js';
import { queueValidator as builtinQueueValidator, foldQueue } from './queue.js';

import logger from '../utils/logger.js';

const COMPONENT = 'CompanyLog';

/** Slice-1 event kinds. */
export const EVENT_KINDS = [
    'company.created',
    'agent.minted',
    'room.message',
    'task.delegated',
    'task.result',
    'task.checked',
] as const;
/** Slice-2 queue kinds (v8 slice 2, design v5). */
export const QUEUE_KINDS = [
    'task.started', 'task.retry', 'task.blocked', 'task.unblocked',
    'hold.set', 'hold.lifted', 'commitment.opened', 'commitment.closed',
] as const;
/** knownKinds: the FULL immutable schema union — decode/read/verify always
 *  work over complete history regardless of capabilities (design v5 §1). */
export const KNOWN_KINDS = [...EVENT_KINDS, ...QUEUE_KINDS] as const;
export type CompanyEventKind = (typeof KNOWN_KINDS)[number];

/** Context handed to an installed lifecycle validator INSIDE the append txn. */
export interface AppendContext extends SystemAppendContext {
    kind: CompanyEventKind;
    /** Narrowed to CompanyEvent[]: the Company feature only registers
     *  Company kinds, so every event in the shared store that reaches a
     *  Company validator IS a CompanyEvent. Overriding the base
     *  SystemEvent[] here fixes the B3 typecheck error (foldQueue expects
     *  CompanyEvent[], not SystemEvent[]). */
    events: readonly CompanyEvent[];
}
export type LifecycleValidator = (ctx: AppendContext) => void;

export interface CompanyLogOptions {
    /** Closed queue mode (review event f0d61bd9 #1): when true, the log
     *  enables the slice-2 kinds AND installs the built-in queue validator
     *  internally. There is NO injectable validator and NO public
     *  appendableKinds — a queue-capable instance is validated by
     *  construction, and the validator cannot be replaced or stubbed. */
    queue?: boolean;
}

/** Which actors may append which kinds (slice 1). '*' = any registered actor. */
const AUTHORITY: Record<string, readonly string[] | '*'> = {
    'company.created': ['user'],
    'agent.minted': ['user'],
    'room.message': '*',
    'task.delegated': ['ceo', 'user'],
    'task.result': '*',
    'task.checked': ['ceo', 'user'],
    // Slice-2 coarse authority; the installed queue validator enforces the
    // fine-grained rules (ownership, refs, transitions, evidence) in-txn.
    'task.started': '*',
    'task.retry': ['user'],
    'task.blocked': '*',
    'task.unblocked': '*',
    'hold.set': ['watchman', 'user'],
    'hold.lifted': ['watchman', 'user'],
    'commitment.opened': '*',
    'commitment.closed': '*',
};

export interface CompanyEvent extends SystemEvent {
    kind: CompanyEventKind;
}

export interface AppendInput {
    kind: CompanyEventKind;
    actor: string;
    payload: Record<string, unknown>;
}

/** Signing context: bridges Company key management to the substrate. */
const companySigning: SigningContext = {
    loadPublicKey: (actor: string, keysDir: string) => loadAgentPublicKey(actor, keysDir),
    verifySigner: (privateKey: KeyObject, registered: KeyObject) =>
        samePublicKey(createPublicKey(privateKey), registered),
    sign: (data: Buffer, privateKey: KeyObject) => signBytes(data, privateKey),
    verify: (data: Buffer, signatureB64: string, publicKey: KeyObject) =>
        verifyBytes(data, signatureB64, publicKey),
    validateActorId: (actor: string) => assertValidAgentId(actor),
};

export class CompanyLog {
    private store: SystemStore;
    private cap: FeatureCapability;
    private isQueueMode: boolean;
    private keysDir: string;

    /**
     * @param titanHome  $TITAN_HOME directory. The substrate derives
     *   `$TITAN_HOME/system.db` as the authoritative system log and
     *   discovers/migrates `$TITAN_HOME/company/company.db` before the
     *   first append. No arbitrary dbPath is accepted (Honey, f485ec93).
     */
    constructor(titanHome: string, keysDir: string, opts: CompanyLogOptions = {}) {
        this.isQueueMode = opts.queue ?? false;
        this.keysDir = keysDir;
        const knownKinds = KNOWN_KINDS as readonly string[];
        const appendableKinds = opts.queue ? knownKinds : (EVENT_KINDS as readonly string[]);

        // Validator adapter: the substrate passes a SystemAppendContext
        // (kind: string, events: SystemEvent[]). The Company validator
        // expects AppendContext (kind: CompanyEventKind, events:
        // CompanyEvent[]). This adapter narrows at the boundary — sound
        // because the Company feature only registers Company kinds, so
        // every event in the one store that reaches this validator IS a
        // CompanyEvent. No `as unknown` cast (Honey B3): the narrowing is
        // explicit and localized here.
        const validator: SystemLifecycleValidator | undefined = opts.queue
            ? (ctx: SystemAppendContext) => {
                builtinQueueValidator({
                    kind: ctx.kind as CompanyEventKind,
                    actor: ctx.actor,
                    payload: ctx.payload,
                    events: ctx.events as readonly CompanyEvent[],
                    capability: ctx.capability,
                });
            }
            : undefined;

        // Bus emit adapter: the substrate emits SystemEvent; the trace bus
        // 'company:event' topic expects CompanyEventPayload, which is
        // structurally identical to SystemEvent (same fields, same types).
        // The cast is structural-identity-only — no runtime change.
        const companyBusEmit = (event: SystemEvent) => {
            busEmit('company:event', event as CompanyEventPayload);
        };

        const reg: FeatureRegistration = {
            featureId: 'company',
            kinds: knownKinds,
            baseAppendable: appendableKinds,
            authority: AUTHORITY,
            validator,
            signing: companySigning,
            keysDir,
            busEmit: companyBusEmit,
            extraDdl: [
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_one_company ON events(kind) WHERE kind = 'company.created'`,
                `CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_attempt ON events(kind, json_extract(payload,'$.taskRef'), json_extract(payload,'$.attempt')) WHERE kind IN ('task.started','task.result')`,
            ],
        };

        this.store = new SystemStore(titanHome, {
            // Legacy signing context (Honey B2): used ONLY to cryptographically
            // verify legacy company.db rows during migration. Company passes
            // its own signing context + keysDir so the substrate can verify
            // pre-existing signed rows without importing Company key management.
            legacySigning: companySigning,
            legacyKeysDir: keysDir,
        });
        this.cap = this.store.registerFeature(reg);
    }

    /**
     * Append one signed event. The private key must belong to input.actor's
     * registered identity, and the actor must hold authority for the kind.
     */
    append(input: AppendInput, privateKey: KeyObject): CompanyEvent {
        return this.cap.append(input, privateKey) as CompanyEvent;
    }

    /** Read events in seq order. Optionally filter by kind / start after a seq. */
    read(opts: { afterSeq?: number; kind?: CompanyEventKind; limit?: number } = {}): CompanyEvent[] {
        return this.cap.read(opts) as CompanyEvent[];
    }

    /**
     * Verify ONE stored event by id: signature over the stored row's exact
     * fields, against the STORED actor's registered key. Caller-supplied
     * fields are never trusted.
     */
    verifyEvent(eventId: string): { ok: boolean; event?: CompanyEvent; reason?: string } {
        return this.cap.verifyEvent(eventId) as { ok: boolean; event?: CompanyEvent; reason?: string };
    }

    /**
     * Verify the ENTIRE log: every signature and every prev_hash link, in
     * seq order. Detects tamper, reorder, re-identification, and splices.
     */
    verifyChain(): { ok: boolean; badSeq?: number; reason?: string } {
        return this.cap.verifyChain();
    }

    /** Uncapped full-history read in seq order (fold/verify use). */
    readAll(): CompanyEvent[] {
        return this.cap.readAll() as CompanyEvent[];
    }

    /**
     * The CLOSED discard operation (reviews 8a2b8b01 #2 / f0d61bd9 #2+#4):
     * the ONLY maintenance surface. No callback, fully synchronous, one
     * atomic BEGIN IMMEDIATE transaction implementing design v5 §3b exactly:
     * user-signed task.unblocked for every active block → hold.lifted for
     * every active hold → terminal task.checked for every nonterminal task
     * (attempt = latest declared, or 1 for never-started). Requires a
     * queue-mode instance and the workspace user key on disk. It can do
     * nothing except this well-defined discard — there is no arbitrary
     * maintenance capability for any caller to reach.
     * Emits buffer and flush only after COMMIT; rollback discards them.
     *
     * AUTHORITY (review f0d61bd9 #1 follow-up, event 037866fc): the log
     * NEVER self-acquires the user signing key. The caller must SUPPLY the
     * user's private key — obtainable only by the authenticated service
     * path for the user-invoked `titan company queue-discard` — and it is
     * verified against the registered user identity before anything runs.
     * An ordinary log holder without that key cannot invoke discard.
     *
     * `afterEachAppend` is an abort-only fault-injection/observability hook
     * (tests force mid-discard rollback with it). It confers no authority:
     * throwing from it can only ABORT the transaction, which any caller
     * could achieve anyway; it cannot alter, add, or authorize anything.
     */
    discardQueueState(userPrivateKey: KeyObject, opts: { afterEachAppend?: () => void } = {}): { unblocked: number; lifted: number; terminalized: number } {
        if (!this.isQueueMode) {
            throw new Error('CompanyLog: discardQueueState requires a queue-mode instance');
        }
        const registered = loadAgentPublicKey('user', this.keysDir);
        if (!registered || !samePublicKey(createPublicKey(userPrivateKey), registered)) {
            throw new Error('CompanyLog: discard requires the registered workspace user key');
        }
        this.cap.beginMaintenance();
        try {
            const user = { privateKey: userPrivateKey };
            const fold = foldQueue(this.readAll());
            let unblocked = 0, lifted = 0, terminalized = 0;
            for (const t of fold.tasks.values()) {
                for (const blockRef of t.activeBlocks.keys()) {
                    this.append({ kind: 'task.unblocked', actor: 'user', payload: { blockRef } }, user.privateKey);
                    unblocked += 1;
                    opts.afterEachAppend?.();
                }
            }
            for (const holdRef of fold.activeHolds.keys()) {
                this.append({ kind: 'hold.lifted', actor: 'user', payload: { holdRef } }, user.privateKey);
                lifted += 1;
                opts.afterEachAppend?.();
            }
            for (const t of fold.tasks.values()) {
                if (t.checked) continue;
                const attempt = t.attempt === 0 ? 1 : t.attempt;
                this.append({
                    kind: 'task.checked', actor: 'user',
                    payload: { taskRef: t.taskRef, verdict: 'needs-work', note: 'discarded on queue downgrade', attempt },
                }, user.privateKey);
                terminalized += 1;
                opts.afterEachAppend?.();
            }
            this.cap.commitMaintenance();
            return { unblocked, lifted, terminalized };
        } catch (err) {
            this.cap.rollbackMaintenance();
            throw err;
        } finally {
            this.cap.endMaintenance();
        }
    }

    /**
     * Neutral cold downgrade scan (reviews f11c9e22, 86794542): counts
     * nonterminal QUEUE-ERA delegations — identified by the SIGNED
     * queueMode flag in their payload, which the queue-mode validator
     * requires at append — plus active holds, WITHOUT importing queue
     * modules. Fully log-derived: a byte-copied log behaves identically,
     * and no unsigned side-store can flip the decision. Slice-1
     * delegations (no flag) never trigger refusal, preserving slice-1
     * crash recovery.
     */
    scanNonterminal(): { nonterminalTasks: number; activeHolds: number } {
        const events = this.readAll();
        const checked = new Set<string>();
        const liftedHolds = new Set<string>();
        for (const e of events) {
            if (e.kind === 'task.checked') checked.add(String((e.payload as { taskRef?: unknown }).taskRef ?? ''));
            if (e.kind === 'hold.lifted') liftedHolds.add(String((e.payload as { holdRef?: unknown }).holdRef ?? ''));
        }
        // Queue adoption evidence (review 17bc9f91): a legacy (unflagged)
        // delegation becomes queue-era the moment ANY validated slice-2
        // lifecycle event references it — those events are themselves
        // signed queue-mode appends, so adoption is signed and replayable
        // without a new event kind.
        const adopted = new Set<string>();
        for (const e of events) {
            // (task.unblocked carries blockRef, not taskRef — started/retry/
            //  blocked already provide complete adoption evidence.)
            if (e.kind === 'task.started' || e.kind === 'task.retry' || e.kind === 'task.blocked') {
                const ref = String((e.payload as { taskRef?: unknown }).taskRef ?? '');
                if (ref) adopted.add(ref);
            }
        }
        let nonterminalTasks = 0, activeHolds = 0;
        for (const e of events) {
            if (e.kind === 'task.delegated'
                && ((e.payload as { queueMode?: unknown }).queueMode === true || adopted.has(e.id))
                && !checked.has(e.id)) nonterminalTasks += 1;
            if (e.kind === 'hold.set' && !liftedHolds.has(e.id)) activeHolds += 1;
        }
        return { nonterminalTasks, activeHolds };
    }

    /** Total number of events (cheap health/consistency probe). */
    count(): number {
        return this.cap.count();
    }

    close(): void {
        try { this.cap.close(); } catch (err) {
            logger.warn(COMPONENT, `close failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
