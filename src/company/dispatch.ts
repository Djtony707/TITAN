/**
 * TITAN — Company dispatch loop (v8 Slice 1)
 *
 * The CEO's two verbs, executed: a task.delegated event runs the delegated
 * agent (via the existing sub-agent machinery — no new agent loop), the
 * agent's outcome lands as a task.result signed BY THAT AGENT, and the CEO
 * reviews the result and appends a task.checked verdict signed by the CEO.
 *
 * Slice-1 queue semantics: strict in-memory FIFO, one task at a time (the
 * real queue platform object is Slice 2). Dispatch failures are CONTAINED:
 * every async path ends in a terminal catch that appends a failure result
 * where possible and never raises an unhandled rejection (the toolRunner
 * telemetry lesson, review event 70e70a88).
 *
 * Runners are injectable for tests; production wires spawnSubAgent with the
 * agent's charter as system prompt. Sub-agents inherit ALL existing safety
 * rails (approval gates, autonomy mode, loop caps) — the company layer adds
 * authority checks at the event log, not a new execution sandbox.
 */
import type { CompanyLog, CompanyEvent } from './log.js';
import { loadAgentKeys } from './keys.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CompanyDispatch';

/** Max stored result size — the room renders summaries, not blobs. */
const MAX_RESULT_CHARS = 8000;

export interface TurnRequest {
    agentId: string;
    charter: string;
    spec: string;
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
            `Complete the delegated task and reply with the finished result.`,
        maxRounds: 6,
        tags: ['company', 'slice1'],
    });
    return { content: res.content, success: res.success, toolsUsed: res.toolsUsed };
};

/** Production reviewer: a bounded, tool-less CEO pass over the result. */
export const productionReviewer: Reviewer = async (req) => {
    const { spawnSubAgent } = await import('../agent/subAgent.js');
    const res = await spawnSubAgent({
        name: 'company:ceo-review',
        task:
            `Task spec: ${req.spec}\nAgent: ${req.agentId}\nResult:\n${req.result.content.slice(0, 4000)}\n\n` +
            `Reply with exactly ACCEPTED or NEEDS-WORK on the first line, then one short sentence of rationale.`,
        systemPrompt: 'You are the CEO. You check the crew\'s work before accepting it. Be strict but fair.',
        maxRounds: 1,
        tools: ['__none__'],
    });
    const accepted = /^\s*ACCEPTED/i.test(res.content) && req.result.success;
    return {
        verdict: accepted ? 'accepted' : 'needs-work',
        note: res.content.split('\n').slice(0, 2).join(' ').slice(0, 300) || 'no rationale returned',
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
        private runner: TurnRunner = productionRunner,
        private reviewer: Reviewer = productionReviewer,
    ) {}

    /** Number of tasks waiting or running (for status surfaces/tests). */
    depth(): number {
        return this.queue.length + (this.running ? 1 : 0);
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
                await this.runOne(item).catch(err => {
                    // Terminal containment: runOne itself contains failures; this
                    // catch only fires on catastrophic paths (e.g. log closed).
                    logger.error(COMPONENT, `dispatch task dropped: ${err instanceof Error ? err.message : String(err)}`);
                });
            }
        } finally {
            this.running = false;
        }
    }

    private async runOne(item: QueueItem): Promise<void> {
        const { delegated, charter } = item;
        const agentId = String(delegated.payload.to ?? '');
        const spec = String(delegated.payload.spec ?? '');

        let outcome: TurnOutcome;
        try {
            outcome = await this.runner({ agentId, charter, spec });
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
