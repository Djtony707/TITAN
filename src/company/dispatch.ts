/**
 * TITAN — Company dispatch loop (v8 Slice 1)
 *
 * task.delegated → the delegated agent runs (existing sub-agent machinery,
 * with its OWN attributed memory stream read into context) → task.result
 * signed BY THAT AGENT (+ an observation appended to its memory stream) →
 * CEO review via a DIRECT model call → task.checked signed by the CEO.
 *
 * Re-review fixes (event a760bf8a):
 *  - #1 The CEO reviewer calls providers/router chat() directly — tool-less
 *    by construction; it cannot hit spawnSubAgent's empty-toolset abort.
 *  - #5 CEO-signed delegation exists: ceoDelegate() appends a task.delegated
 *    signed by the CEO's own key; memory streams are real (read+write).
 *  - #6 Durability: recover() re-enqueues persisted task.delegated events
 *    that never reached a task.checked (crash reconciliation); the ENTIRE
 *    per-task pipeline — key loads and appends included — runs inside
 *    containment, and a catastrophic failure still attempts a durable
 *    terminal task.checked before giving up.
 *
 * Queue semantics: strict in-memory FIFO, one task at a time (the queue
 * platform object is Slice 2); durability comes from the event log itself
 * plus startup reconciliation, not from queue persistence.
 */
import type { CompanyLog, CompanyEvent } from './log.js';
import { loadAgentKeys } from './keys.js';
import { appendMemory, renderMemoryForPrompt } from './memoryStream.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CompanyDispatch';

/** Max stored result size — the room renders summaries, not blobs. */
const MAX_RESULT_CHARS = 8000;

export interface TurnRequest {
    agentId: string;
    charter: string;
    spec: string;
    /** The agent's own memory-stream context, pre-rendered. */
    memoryContext: string;
}

export interface TurnOutcome {
    content: string;
    success: boolean;
    toolsUsed: string[];
}

export type TurnRunner = (req: TurnRequest) => Promise<TurnOutcome>;

export interface ReviewRequest {
    spec: string;
    agentId: string;
    result: TurnOutcome;
}

export interface ReviewOutcome {
    verdict: 'accepted' | 'needs-work';
    note: string;
}

export type Reviewer = (req: ReviewRequest) => Promise<ReviewOutcome>;

/** Production runner: the delegated agent's turn through spawnSubAgent. */
export const productionRunner: TurnRunner = async (req) => {
    const { spawnSubAgent } = await import('../agent/subAgent.js');
    const res = await spawnSubAgent({
        name: `company:${req.agentId}`,
        task: req.spec,
        systemPrompt:
            `You are ${req.agentId}, a member of this TITAN company. Your charter: ${req.charter}\n` +
            req.memoryContext +
            `Complete the delegated task and reply with the finished result.`,
        maxRounds: 6,
        tags: ['company', 'slice1'],
    });
    return { content: res.content, success: res.success, toolsUsed: res.toolsUsed };
};

/**
 * Production reviewer — a DIRECT chat() call (re-review fix #1). Tool-less
 * by construction: no toolset is offered, so no tool-filtering path exists
 * to abort on. Bounded, single round, no streaming.
 */
export const productionReviewer: Reviewer = async (req) => {
    const { chat } = await import('../providers/router.js');
    const res = await chat({
        messages: [
            {
                role: 'system',
                content: 'You are the CEO. You check the crew\'s work before accepting it. Be strict but fair. ' +
                    'Reply with exactly ACCEPTED or NEEDS-WORK on the first line, then one short sentence of rationale.',
            },
            {
                role: 'user',
                content: `Task spec: ${req.spec}\nAgent: ${req.agentId}\nAgent reported success: ${req.result.success}\n` +
                    `Result:\n${req.result.content.slice(0, 4000)}`,
            },
        ],
        maxTokens: 200,
    });
    const text = typeof res.content === 'string' ? res.content : String(res.content ?? '');
    const accepted = /^\s*ACCEPTED/i.test(text) && req.result.success;
    return {
        verdict: accepted ? 'accepted' : 'needs-work',
        note: text.split('\n').slice(0, 2).join(' ').slice(0, 300) || 'no rationale returned',
    };
};

interface QueueItem {
    delegated: CompanyEvent;
    charter: string;
}

export class CompanyDispatch {
    private queue: QueueItem[] = [];
    private running = false;

    constructor(
        private log: CompanyLog,
        private keysDir: string,
        private memoryDir: string,
        private runner: TurnRunner = productionRunner,
        private reviewer: Reviewer = productionReviewer,
    ) {}

    /** Number of tasks waiting or running (for status surfaces/tests). */
    depth(): number {
        return this.queue.length + (this.running ? 1 : 0);
    }

    /**
     * CEO-signed delegation (re-review fix #5): the CEO delegates work in
     * its own name, signed with its own key, and the task dispatches like
     * any other. Returns the delegated event.
     */
    ceoDelegate(to: string, spec: string, charter: string): CompanyEvent {
        const ceo = loadAgentKeys('ceo', this.keysDir);
        const event = this.log.append(
            { kind: 'task.delegated', actor: 'ceo', payload: { from: 'ceo', to, spec } },
            ceo.privateKey,
        );
        this.enqueue(event, charter);
        return event;
    }

    /**
     * Startup reconciliation (re-review fix #6): any persisted task.delegated
     * with no terminal task.checked is re-enqueued, so a crash between
     * delegation and check can not silently lose a task.
     */
    recover(charterOf: (agentId: string) => string): number {
        const delegated = this.log.read({ kind: 'task.delegated', limit: 5000 });
        const checkedRefs = new Set(
            this.log.read({ kind: 'task.checked', limit: 5000 }).map(e => String(e.payload.taskRef)),
        );
        let recovered = 0;
        for (const ev of delegated) {
            if (checkedRefs.has(ev.id)) continue;
            this.enqueue(ev, charterOf(String(ev.payload.to ?? '')));
            recovered += 1;
        }
        if (recovered > 0) logger.info(COMPONENT, `Recovered ${recovered} unfinished task(s) from the log`);
        return recovered;
    }

    /**
     * Enqueue a delegated task. Fire-and-forget safe: returns immediately,
     * processing is serialized, and no failure escapes as a rejection.
     */
    enqueue(delegated: CompanyEvent, charter: string): void {
        this.queue.push({ delegated, charter });
        void this.drain();
    }

    /** Await quiescence (tests). */
    async idle(): Promise<void> {
        while (this.running || this.queue.length > 0) {
            await new Promise(r => setTimeout(r, 5));
        }
    }

    private async drain(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            while (this.queue.length > 0) {
                const item = this.queue.shift() as QueueItem;
                // Full-pipeline containment (re-review fix #6): key loads and
                // appends are INSIDE; a catastrophic failure still attempts a
                // durable terminal check before the task is surrendered.
                await this.runOne(item).catch(err => {
                    logger.error(COMPONENT, `task pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
                    this.appendTerminalFailure(item.delegated, err).catch(e2 =>
                        logger.error(COMPONENT, `terminal-failure append also failed: ${e2 instanceof Error ? e2.message : String(e2)}`),
                    );
                });
            }
        } finally {
            this.running = false;
        }
    }

    /** Durable terminal failure: a needs-work check recording the pipeline error. */
    private async appendTerminalFailure(delegated: CompanyEvent, err: unknown): Promise<void> {
        const ceoKeys = loadAgentKeys('ceo', this.keysDir);
        this.log.append(
            {
                kind: 'task.checked',
                actor: 'ceo',
                payload: {
                    taskRef: delegated.id,
                    verdict: 'needs-work',
                    note: `Dispatch pipeline failure: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300),
                },
            },
            ceoKeys.privateKey,
        );
    }

    private async runOne(item: QueueItem): Promise<void> {
        const { delegated, charter } = item;
        const agentId = String(delegated.payload.to ?? '');
        const spec = String(delegated.payload.spec ?? '');

        let outcome: TurnOutcome;
        try {
            outcome = await this.runner({
                agentId, charter, spec,
                memoryContext: renderMemoryForPrompt(this.memoryDir, agentId),
            });
        } catch (err) {
            outcome = {
                content: `Task failed: ${err instanceof Error ? err.message : String(err)}`,
                success: false,
                toolsUsed: [],
            };
        }

        const agentKeys = loadAgentKeys(agentId, this.keysDir);
        const result = this.log.append(
            {
                kind: 'task.result',
                actor: agentId,
                payload: {
                    taskRef: delegated.id,
                    content: outcome.content.slice(0, MAX_RESULT_CHARS),
                    success: outcome.success,
                    toolsUsed: outcome.toolsUsed,
                },
            },
            agentKeys.privateKey,
        );

        // The agent's OWN attributed memory: what it did and how it went.
        try {
            appendMemory(this.memoryDir, {
                agentId,
                kind: 'observation',
                text: `Task "${spec.slice(0, 120)}" → ${outcome.success ? 'succeeded' : 'failed'}: ${outcome.content.slice(0, 200)}`,
                eventRef: result.id,
            });
        } catch (err) {
            logger.warn(COMPONENT, `memory append failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
        }

        let review: ReviewOutcome;
        try {
            review = await this.reviewer({ spec, agentId, result: outcome });
        } catch (err) {
            review = {
                verdict: 'needs-work',
                note: `Review failed: ${err instanceof Error ? err.message : String(err)}`,
            };
        }

        const ceoKeys = loadAgentKeys('ceo', this.keysDir);
        this.log.append(
            {
                kind: 'task.checked',
                actor: 'ceo',
                payload: { taskRef: delegated.id, resultRef: result.id, verdict: review.verdict, note: review.note },
            },
            ceoKeys.privateKey,
        );
    }
}
