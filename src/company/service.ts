/**
 * TITAN — Company service layer (v8 Slice 1)
 *
 * The five functions the gateway router calls (see
 * src/gateway/routes/company.ts). This module owns the singleton wiring:
 * paths under $TITAN_HOME/company, the runtime compat gate, and the lazy
 * import of the node:sqlite-backed log (so this file itself is safe to
 * import on any supported Node — the sqlite dependency only loads when
 * the company layer actually activates).
 *
 * Authority note (slice 1): everything a human does through the gateway
 * is a 'user' act signed with the workspace user key — the user outranks
 * the CEO on their own machine. CEO-signed delegation/checks arrive with
 * the dispatch loop in a later patch.
 */
import { join } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import { assertCompanyRuntime } from './compat.js';
import { mintCompany, STARTER_CREW, type MintedCompany } from './crew.js';
import { loadAgentKeys, assertValidAgentId } from './keys.js';
import { LIMITS, assertLen } from './wire.js';
import { loadConfig } from '../config/config.js';
import type { KeyObject } from 'crypto';
import type { CompanyDispatch } from './dispatch.js';
import type { BasicCompanyDispatch } from './dispatchBasic.js';
import type { CompanyLog, CompanyEvent } from './log.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CompanyService';

interface State {
    log: CompanyLog;
    keysDir: string;
    memoryDir: string;
    /** Exactly one of these is set, per company.queue.enabled. */
    queueDispatch?: CompanyDispatch;
    basicDispatch?: BasicCompanyDispatch;
}

let state: State | null = null;

async function ensure(): Promise<State> {
    assertCompanyRuntime();
    if (!state) {
        const { CompanyLog } = await import('./log.js');
        // Validated config path (review 9a85bc9f #1): company.queue now
        // exists in TitanConfigSchema — no unknown-key casting.
        const cfg = loadConfig();
        const queueCfg = (cfg as { company: { queue: { enabled: boolean; maxAttempts: number } } }).company.queue;
        const queueEnabled = Boolean(queueCfg?.enabled);
        const root = join(TITAN_HOME, 'company');
        const keysDir = join(root, 'keys');
        const log = new CompanyLog(join(root, 'company.db'), keysDir, queueEnabled ? { queue: true } : {});
        const memoryDir = join(root, 'memory');
        const crew = new Map(log.read({ kind: 'agent.minted', limit: 100 })
            .map(e => [String(e.payload.agentId ?? ''), String(e.payload.charter ?? '')]));
        state = { log, keysDir, memoryDir };
        logger.info(COMPONENT, `Company log open (queue ${queueEnabled ? 'ON' : 'off'})`);

        if (queueEnabled) {
            // Queue modules load ONLY here (flag-off contract: unimported).
            const { CompanyDispatch, productionRunner, productionReviewer } = await import('./dispatch.js');
            state.queueDispatch = new CompanyDispatch(log, keysDir, memoryDir, {
                maxAttempts: queueCfg.maxAttempts,
                charterOf: agentId => crew.get(agentId) ?? '',
            }, productionRunner, productionReviewer);
            state.queueDispatch.recover(); // fold-derived crash reconciliation (v5 §4)
        } else {
            // Slice-1 pipeline preserved EXACTLY when the sub-flag is off
            // (review 9a85bc9f #2): basic dispatcher, slice-1 kinds only,
            // no queue modules imported by it.
            const { BasicCompanyDispatch, productionRunner, productionReviewer } = await import('./dispatchBasic.js');
            state.basicDispatch = new BasicCompanyDispatch(log, keysDir, memoryDir, productionRunner, productionReviewer);
            // DOWNGRADE REFUSAL (v5 §3): nonterminal queue-era work or active
            // holds make TASK FLOW read-only. The check necessarily reads
            // queue history — foldQueue loads lazily just for this read.
            const { foldQueue } = await import('./queue.js');
            const f = foldQueue(log.readAll());
            const queueEra = [...f.tasks.values()].some(t => !t.checked && (t.attempt > 0 || t.activeBlocks.size > 0))
                || f.activeHolds.size > 0;
            if (queueEra) {
                queueRefusal = 'Queue history contains unfinished work or active holds. ' +
                    'Re-enable company.queue.enabled, or run `titan company queue-discard` to terminalize it.';
                logger.warn(COMPONENT, `READ-ONLY REFUSAL: ${queueRefusal}`);
            } else {
                state.basicDispatch.recover(agentId => crew.get(agentId) ?? '');
            }
        }
    }
    return state;
}

/** Non-null when the v5 §3 downgrade refusal is active. */
let queueRefusal: string | null = null;

function assertNotRefused(): void {
    if (queueRefusal) throw new Error(`Company dispatch is read-only: ${queueRefusal}`);
}

/**
 * The authenticated queue-discard path (v5 §3b): user-invoked via
 * `titan company queue-discard` (CLI) — THIS function loads the user key
 * from the workspace and hands it to the closed log operation. The log
 * itself never self-acquires it (review 037866fc).
 */
export async function queueDiscard(userPrivateKey: KeyObject): Promise<{ unblocked: number; lifted: number; terminalized: number }> {
    // NON-AMBIENT (review 9a85bc9f #3): this service op does NOT acquire the
    // user key. The authenticated CLI boundary (`titan company queue-discard`)
    // loads it and passes it here; the closed log op verifies it against the
    // registered user identity. An in-process caller without the user key
    // cannot trigger a discard.
    const { CompanyLog } = await import('./log.js');
    const root = join(TITAN_HOME, 'company');
    const keysDir = join(root, 'keys');
    const log = new CompanyLog(join(root, 'company.db'), keysDir, { queue: true });
    try {
        const out = log.discardQueueState(userPrivateKey);
        queueRefusal = null; // refusal condition cleared
        logger.info(COMPONENT, `queue-discard: ${out.unblocked} unblocked, ${out.lifted} lifted, ${out.terminalized} terminalized`);
        return out;
    } finally {
        log.close();
    }
}

export interface CompanyStatus {
    exists: boolean;
    name?: string;
    mission?: string;
    agents: Array<{ agentId: string; displayName: string; role: string; charter: string }>;
    eventCount: number;
}

/** GET /api/company */
export async function getCompanyStatus(): Promise<CompanyStatus> {
    const { log } = await ensure();
    const created = log.read({ kind: 'company.created', limit: 1 })[0];
    if (!created) return { exists: false, agents: [], eventCount: log.count() };
    const agents = log.read({ kind: 'agent.minted', limit: 100 }).map(e => ({
        agentId: String(e.payload.agentId ?? ''),
        displayName: String(e.payload.displayName ?? e.payload.agentId ?? ''),
        role: String(e.payload.role ?? ''),
        charter: String(e.payload.charter ?? ''),
    }));
    return {
        exists: true,
        name: String(created.payload.name ?? ''),
        mission: created.payload.mission ? String(created.payload.mission) : undefined,
        agents,
        eventCount: log.count(),
    };
}

/** POST /api/company — idempotent: slice 1 supports exactly one company. */
export async function createCompany(opts: { name: string; mission?: string }): Promise<CompanyStatus> {
    const { log, keysDir } = await ensure();
    assertLen(opts.name, LIMITS.companyName, 'company name');
    if (opts.mission) assertLen(opts.mission, LIMITS.mission, 'mission');
    const existing = await getCompanyStatus();
    if (existing.exists) return existing;
    try {
        const minted: MintedCompany = mintCompany(log, keysDir, opts);
        logger.info(COMPONENT, `Company "${minted.name}" minted with ${minted.agents.length} agents`);
    } catch (err) {
        // Transactional idempotency: the log's unique one-company index makes
        // a concurrent double-create lose here — converge on the winner.
        if (!/UNIQUE|idx_one_company/i.test(err instanceof Error ? err.message : '')) throw err;
        logger.info(COMPONENT, 'Concurrent company creation detected — returning the existing company');
    }
    return getCompanyStatus();
}

/** GET /api/company/room */
export async function getRoomEvents(opts: { after?: number; limit?: number }): Promise<CompanyEvent[]> {
    const { log } = await ensure();
    return log.read({ afterSeq: opts.after && opts.after > 0 ? opts.after : undefined, limit: opts.limit });
}

/** POST /api/company/room — the human speaks in the room, as themselves. */
export async function postUserMessage(text: string, replyTo?: string): Promise<CompanyEvent> {
    const { log, keysDir } = await ensure();
    // room chat stays available under refusal — only task flow is read-only
    assertLen(text, LIMITS.roomText, 'message text');
    if (replyTo) assertLen(replyTo, LIMITS.replyTo, 'replyTo');
    if (!(await getCompanyStatus()).exists) throw new Error('No company exists yet — create one first');
    const user = loadAgentKeys('user', keysDir);
    return log.append(
        { kind: 'room.message', actor: 'user', payload: { text, replyTo: replyTo ?? null } },
        user.privateKey,
    );
}

/** POST /api/company/delegate — user-initiated delegation (user outranks CEO on their machine). */
export async function delegateTask(opts: { from: string; to: string; spec: string }): Promise<CompanyEvent> {
    const { log, keysDir } = await ensure();
    assertNotRefused();
    assertValidAgentId(opts.to);
    assertLen(opts.spec, LIMITS.taskSpec, 'task spec');
    const status = await getCompanyStatus();
    if (!status.exists) throw new Error('No company exists yet — create one first');
    if (!status.agents.some(a => a.agentId === opts.to)) {
        throw new Error(`No such agent "${opts.to}" — crew: ${status.agents.map(a => a.agentId).join(', ')}`);
    }
    const user = loadAgentKeys('user', keysDir);
    // Gateway delegations are user acts (the user outranks the CEO locally).
    const event = log.append(
        { kind: 'task.delegated', actor: 'user', payload: { from: 'user', to: opts.to, spec: opts.spec } },
        user.privateKey,
    );
    const st = await ensure();
    if (st.queueDispatch) {
        st.queueDispatch.kick();
    } else if (st.basicDispatch) {
        const charter = status.agents.find(a => a.agentId === opts.to)?.charter ?? '';
        st.basicDispatch.enqueue(event, charter);
    }
    return event;
}

/** CEO-signed delegation (re-review #5): the CEO delegates in its own name. */
export async function ceoDelegateTask(opts: { to: string; spec: string }): Promise<CompanyEvent> {
    const st = await ensure();
    assertNotRefused();
    assertValidAgentId(opts.to);
    assertLen(opts.spec, LIMITS.taskSpec, 'task spec');
    const status = await getCompanyStatus();
    if (!status.exists) throw new Error('No company exists yet — create one first');
    const agent = status.agents.find(a => a.agentId === opts.to);
    if (!agent) throw new Error(`No such agent "${opts.to}"`);
    if (st.queueDispatch) return st.queueDispatch.ceoDelegate(opts.to, opts.spec);
    if (!st.basicDispatch) throw new Error('Company dispatch unavailable');
    return st.basicDispatch.ceoDelegate(opts.to, opts.spec, agent.charter);
}

export { STARTER_CREW };
