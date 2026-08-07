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
import { CompanyDispatch, productionRunner, productionReviewer } from './dispatch.js';
import type { CompanyLog, CompanyEvent } from './log.js';
import logger from '../utils/logger.js';

const COMPONENT = 'CompanyService';

interface State {
    log: CompanyLog;
    keysDir: string;
    dispatch: CompanyDispatch;
}

let state: State | null = null;

async function ensure(): Promise<State> {
    assertCompanyRuntime();
    if (!state) {
        const { CompanyLog } = await import('./log.js');
        const root = join(TITAN_HOME, 'company');
        const keysDir = join(root, 'keys');
        const log = new CompanyLog(join(root, 'company.db'), keysDir);
        state = { log, keysDir, dispatch: new CompanyDispatch(log, keysDir, productionRunner, productionReviewer) };
        logger.info(COMPONENT, `Company log open at ${join(root, 'company.db')}`);
    }
    return state;
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
    // Kick the dispatch loop: the delegated agent runs, its result lands as a
    // task.result signed by that agent, and the CEO appends a task.checked.
    // enqueue() is fire-and-forget SAFE — every failure path inside dispatch
    // is contained (no unhandled rejections, the toolRunner telemetry lesson).
    const charter = status.agents.find(a => a.agentId === opts.to)?.charter ?? '';
    (await ensure()).dispatch.enqueue(event, charter);
    return event;
}

export { STARTER_CREW };
