/**
 * TITAN — Hire/fire flow (v8 Slice 7, Part 2)
 *
 * The consumer of the brain-store roster events: hiring an agent mints a
 * real ed25519 identity and records `agent.hired` on the signed log (the
 * brain validator gates it); the merged roster feeds dispatch, so a hire is
 * immediately delegable and runnable. Retiring appends `agent.retired`,
 * which the validator turns into WRITE REVOCATION for the agent's key.
 *
 * North star: the hire spec carries the per-agent HARNESS and MODEL choice.
 * The meta-agent path is simply this API used by the `ceo` principal — the
 * user can appoint the CEO to run hiring, or hire directly as `user`.
 * Council ruling (gpt-5.6-sol): hires get immediate charter-scoped brain
 * writes — memory is attributed, non-executable, and retractable; probation
 * belongs on tool/capability authority, not on a teammate's own stream.
 */
import type { KeyObject } from 'crypto';
import type { CompanyEvent, CompanyLog } from './log.js';
import { mintAgentKeys, type AgentKeys } from './keys.js';
import {
    appendAgentHired, appendAgentRetired, foldBrain,
    type AgentHiredPayload, type AgentRetiredPayload,
} from './brain.js';

export interface HireResult {
    event: CompanyEvent;
    keys: AgentKeys;
}

/**
 * Hire a new teammate: mint identity keys (idempotent), then record the
 * hire. The append enforces authority (`ceo`/`user`) and the roster rules
 * (no duplicate hire, founding principals protected, charter required).
 * Key mint precedes the append so a registered identity always exists for
 * any hire the log accepts; a key with no hire record is inert.
 */
export function hireAgent(
    log: CompanyLog,
    keysDir: string,
    actor: string,
    actorKey: KeyObject,
    spec: AgentHiredPayload,
): HireResult {
    const keys = mintAgentKeys(spec.agentId, keysDir);
    const event = appendAgentHired(log, actor, actorKey, spec);
    return { event, keys };
}

/** Retire a teammate. The validator revokes its brain writes from this
 *  event onward (log order, not payload time). Keys stay on disk — the
 *  audit trail must keep verifying historical signatures. */
export function retireAgent(
    log: CompanyLog,
    actor: string,
    actorKey: KeyObject,
    payload: AgentRetiredPayload,
): CompanyEvent {
    return appendAgentRetired(log, actor, actorKey, payload);
}

// ── Merged roster (dispatchable set) ─────────────────────────────────────

export interface RosterMember {
    agentId: string;
    displayName: string;
    role: string;
    charter: string;
    harness?: string;
    model?: string;
    /** 'minted' = slice-1 founding crew (immutable); 'hired' = slice-7. */
    source: 'minted' | 'hired';
}

/**
 * The full dispatchable roster: founding crew (`agent.minted`, immutable)
 * merged with live slice-7 hires (`agent.hired` minus `agent.retired`,
 * folded in log order). A hired id can shadow nothing: the brain validator
 * refuses hiring founding principals, and minted ids win on collision.
 */
export function companyRoster(log: CompanyLog): RosterMember[] {
    const events = log.readAll();
    const out = new Map<string, RosterMember>();
    for (const e of events) {
        if (e.kind !== 'agent.minted') continue;
        const p = e.payload as Record<string, unknown>;
        const agentId = String(p.agentId ?? '');
        if (!agentId) continue;
        out.set(agentId, {
            agentId,
            displayName: String(p.displayName ?? agentId),
            role: String(p.role ?? ''),
            charter: String(p.charter ?? ''),
            source: 'minted',
        });
    }
    const fold = foldBrain(events);
    for (const row of fold.roster.values()) {
        if (row.status !== 'hired') continue;
        if (out.has(row.agentId)) continue; // minted wins — validator refuses these anyway
        out.set(row.agentId, {
            agentId: row.agentId,
            displayName: row.displayName,
            role: row.role,
            charter: row.charter,
            ...(row.harness ? { harness: row.harness } : {}),
            ...(row.model ? { model: row.model } : {}),
            source: 'hired',
        });
    }
    return [...out.values()];
}
