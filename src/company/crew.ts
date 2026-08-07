/**
 * TITAN — Company crew minting (v8 Slice 1)
 *
 * Mints the workspace principals: the user key, the CEO, and a fixed
 * starter crew. Slice 1 deliberately uses PACKAGED, reviewed persona
 * definitions (below) — the generative hiring interview is slice-7 work
 * (V8_SLICES.md sharpening #1). Each agent gets:
 *   - a persona (role, charter, system prompt seed)
 *   - its own ed25519 keypair (keys.ts)
 *   - its own attributed memory stream (memory taxonomy tag, wired when
 *     agents execute in patch 4 — the stream id is minted here)
 */
import type { CompanyLog } from './log.js';
import { mintAgentKeys, type AgentKeys } from './keys.js';

export interface PersonaPack {
    agentId: string;
    displayName: string;
    role: string;
    charter: string;
}

/** Slice-1 packaged starter crew. CEO + two specialists. */
export const STARTER_CREW: PersonaPack[] = [
    {
        agentId: 'ceo',
        displayName: 'CEO',
        role: 'ceo',
        charter: 'Runs the company: delegates tasks to the crew, checks results before accepting them, keeps the room readable.',
    },
    {
        agentId: 'scout',
        displayName: 'Scout',
        role: 'research',
        charter: 'Research and fact-finding. Answers questions with sources.',
    },
    {
        agentId: 'builder',
        displayName: 'Builder',
        role: 'engineering',
        charter: 'Code, files, and artifacts. Produces reviewable work products.',
    },
];

export interface MintedCompany {
    name: string;
    mission?: string;
    agents: Array<PersonaPack & { publicKeyPem: string; memoryStream: string }>;
}

/**
 * Mint the company into the log: company.created + one agent.minted per
 * crew member. Idempotent at the service layer (service.ts refuses a
 * second mint); this function assumes a fresh log.
 */
export function mintCompany(
    log: CompanyLog,
    keysDir: string,
    opts: { name: string; mission?: string },
): MintedCompany {
    const user: AgentKeys = mintAgentKeys('user', keysDir);
    log.append(
        { kind: 'company.created', actor: 'user', payload: { name: opts.name, mission: opts.mission ?? null } },
        user.privateKey,
    );

    const agents: MintedCompany['agents'] = [];
    for (const pack of STARTER_CREW) {
        const keys = mintAgentKeys(pack.agentId, keysDir);
        const memoryStream = `company/${pack.agentId}`;
        // Minting is a user act in slice 1 (the user approves the packaged crew
        // by running `titan company`); agents sign their own events from then on.
        log.append(
            {
                kind: 'agent.minted',
                actor: 'user',
                payload: { ...pack, publicKeyPem: keys.publicKeyPem, memoryStream },
            },
            user.privateKey,
        );
        agents.push({ ...pack, publicKeyPem: keys.publicKeyPem, memoryStream });
    }
    return { name: opts.name, mission: opts.mission, agents };
}
