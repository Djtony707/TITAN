/**
 * TITAN — Machine Router (v4.10.0-local, Phase C)
 *
 * Routes goal execution to the right machine in the fleet based on
 * capability hints in the goal's tags. Tony's setup has 3 machines:
 *
 *   - Titan PC   — RTX 5090, i9-14900KF, 64GB DDR5. Heavy compute.
 *   - Mini PC    — Smaller, always-on. Good for edge/background.
 *   - MacBook Pro — Dev machine, not always online.
 *
 * Tag vocabulary (in goal.tags):
 *   - gpu-heavy, cuda, training, inference → Titan PC
 *   - browser, scraping, captcha → whichever has browser pool
 *   - edge, homeassistant, always-on → Mini PC
 *   - local-dev, mac-only → MacBook
 *   - (none) → default (the machine running TITAN — usually Titan PC)
 *
 * The router returns a machine identifier. The caller (mission or driver)
 * either runs locally (if this is that machine) or dispatches via the
 * existing mesh networking layer (if this is not).
 *
 * For Phase C we support "local" vs "remote" routing signal. Full mesh
 * dispatch integration is Phase D.
 */
import logger from '../utils/logger.js';

const COMPONENT = 'MachineRouter';

export type MachineId = 'titan-pc' | 'mini-pc' | 'macbook' | 'local' | 'auto';

export interface MachineCapabilities {
    id: MachineId;
    name: string;
    /** Hostname / mesh address for dispatch */
    address?: string;
    /** Capability tags this machine advertises */
    capabilities: string[];
    /** Is this machine currently reachable? */
    online: boolean;
    /** Last seen timestamp if known */
    lastSeenAt?: string;
}

// ── Fleet registry ───────────────────────────────────────────────

// Hardcoded fleet map. Can be overridden via config in v2.
const FLEET: MachineCapabilities[] = [
    {
        id: 'titan-pc',
        name: 'Titan PC',
        address: '192.168.1.11',
        capabilities: ['gpu-heavy', 'cuda', 'training', 'inference', 'ollama', 'browser'],
        online: true,
    },
    {
        id: 'mini-pc',
        name: 'Mini PC',
        address: '192.168.1.95',
        capabilities: ['edge', 'always-on', 'homeassistant', 'background'],
        online: true,
    },
    {
        id: 'macbook',
        name: 'MacBook Pro',
        capabilities: ['local-dev', 'mac-only', 'coding'],
        online: false, // assumed offline by default; pinged by heartbeat
    },
];

// ── Tag extraction + scoring ─────────────────────────────────────

const TAG_TO_CAPABILITY: Record<string, string> = {
    'gpu-heavy': 'gpu-heavy',
    'gpu': 'gpu-heavy',
    'cuda': 'cuda',
    'training': 'training',
    'ml-training': 'training',
    'inference': 'inference',
    'ollama': 'ollama',
    'browser': 'browser',
    'scraping': 'browser',
    'captcha': 'browser',
    'edge': 'edge',
    'always-on': 'always-on',
    'homeassistant': 'homeassistant',
    'ha': 'homeassistant',
    'local-dev': 'local-dev',
    'mac-only': 'mac-only',
};

function extractCapabilitiesFromTags(tags: string[]): string[] {
    const caps = new Set<string>();
    for (const t of tags) {
        const cap = TAG_TO_CAPABILITY[t.toLowerCase()];
        if (cap) caps.add(cap);
    }
    return Array.from(caps);
}

// ── Route ────────────────────────────────────────────────────────

export interface RoutingDecision {
    targetMachine: MachineId;
    /** True = run here, False = dispatch via mesh. */
    runLocally: boolean;
    rationale: string;
    alternateMachines: MachineId[];
}

/**
 * Decide where to run. Returns `local` if:
 *   - No capability hints in tags (goal doesn't care where)
 *   - The local machine is the best match
 *   - The best-match machine is offline (fall back to local)
 */
export function routeGoalToMachine(tags: string[], localMachineId: MachineId = 'titan-pc'): RoutingDecision {
    const required = extractCapabilitiesFromTags(tags);
    if (required.length === 0) {
        return {
            targetMachine: 'local',
            runLocally: true,
            rationale: 'No capability hints in tags — running locally',
            alternateMachines: [],
        };
    }

    // Score each machine by capability match
    const scored = FLEET.map(m => {
        const matches = required.filter(r => m.capabilities.includes(r)).length;
        return { machine: m, score: matches };
    }).sort((a, b) => b.score - a.score);

    // If no machine matches, fall through to local
    if (scored[0].score === 0) {
        return {
            targetMachine: 'local',
            runLocally: true,
            rationale: `No machine advertises ${required.join(', ')} — running locally`,
            alternateMachines: [],
        };
    }

    const best = scored[0].machine;
    const alternates = scored.slice(1).filter(s => s.score > 0).map(s => s.machine.id);

    // If best is offline, fall back to local
    if (!best.online) {
        const nextOnline = scored.find(s => s.machine.online && s.score > 0);
        if (nextOnline) {
            return {
                targetMachine: nextOnline.machine.id,
                runLocally: nextOnline.machine.id === localMachineId,
                rationale: `Best match ${best.name} is offline; falling back to ${nextOnline.machine.name}`,
                alternateMachines: alternates,
            };
        }
        return {
            targetMachine: 'local',
            runLocally: true,
            rationale: `All matching machines offline — running locally`,
            alternateMachines: alternates,
        };
    }

    return {
        targetMachine: best.id,
        runLocally: best.id === localMachineId,
        rationale: `Best match: ${best.name} (${scored[0].score} of ${required.length} caps)`,
        alternateMachines: alternates,
    };
}

/**
 * Update a machine's online status. Called by heartbeat / mesh-ping.
 */
export function updateMachineStatus(id: MachineId, online: boolean, lastSeenAt?: string): void {
    const m = FLEET.find(f => f.id === id);
    if (!m) {
        logger.warn(COMPONENT, `Unknown machine id: ${id}`);
        return;
    }
    m.online = online;
    if (lastSeenAt) m.lastSeenAt = lastSeenAt;
}

export function getFleetState(): MachineCapabilities[] {
    return FLEET.map(m => ({ ...m, capabilities: [...m.capabilities] }));
}

export function _resetFleetForTests(): void {
    // No-op — tests should override via specific updateMachineStatus calls
}
