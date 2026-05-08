/**
 * TITAN — Persona Profiles (v5.5.24+, Dad Mode plumbing)
 *
 * Resolves "who TITAN is right now" from time-of-day + channel pin +
 * caller identity, returning a single PersonaProfile that other layers
 * (tool filter, system prompt, autopilot, social poster) can consult.
 *
 * Three downstream features depend on this resolver:
 *   #5 Beat-Match Mode — registered audio gestures route to the
 *       active persona's tool set
 *   #7 Stage Mode — livestream co-host pinned via persona='stagehost'
 *   #8 Dad Mode — evening 18-21 wind-down + family-safe tool restriction
 *
 * The resolver is pure (no I/O) and cheap to call per request. The cost
 * is one config read + a handful of string compares; it runs once per
 * processMessage and once per autopilot tick.
 *
 * If `personas.enabled` is false the resolver returns null and every
 * caller short-circuits to its pre-personas behavior — TITAN runs
 * exactly as before opt-in.
 */
import { loadConfig } from '../config/config.js';
import logger from '../utils/logger.js';
import type { TitanConfig } from '../config/schema.js';

const COMPONENT = 'PersonaProfiles';

export type PersonaProfile = NonNullable<TitanConfig['personas']>['profiles'][number];

export interface ResolveContext {
    /** Channel string the request came in on (e.g. 'telegram', 'api'). */
    channel?: string;
    /** Test override — defaults to new Date() at call time. */
    now?: Date;
    /**
     * Optional explicit override (Mission Control "Force Persona" toggle,
     * or a per-request body flag). Wins over schedule + channel pin.
     */
    forceId?: string;
}

/**
 * Returns the persona that should be active for this request, or null
 * when persona-mode is disabled. Never throws — on config error returns
 * null so callers fall through to baseline behavior.
 */
export function resolveActivePersona(ctx: ResolveContext = {}): PersonaProfile | null {
    let config: TitanConfig;
    try {
        config = loadConfig();
    } catch (err) {
        logger.warn(COMPONENT, `loadConfig failed: ${(err as Error).message}`);
        return null;
    }
    const personas = config.personas;
    if (!personas?.enabled) return null;

    const { profiles, defaultPersona, channelPins } = personas;
    if (!profiles || profiles.length === 0) return null;

    const byId = new Map(profiles.map(p => [p.id, p]));
    const fallback = byId.get(defaultPersona) ?? profiles[0];

    // 1. Explicit override wins.
    if (ctx.forceId) {
        const forced = byId.get(ctx.forceId);
        if (forced) return forced;
    }

    // 2. Channel pin (e.g. iPad Telegram bot → 'dad').
    if (ctx.channel && channelPins?.[ctx.channel]) {
        const pinned = byId.get(channelPins[ctx.channel]);
        if (pinned) return pinned;
    }

    // 3. Time-window schedule. First match wins. Schedules supporting
    //    midnight crossover (e.g. 22:00 → 06:00) are detected when
    //    fromMins > toMins.
    const now = ctx.now ?? new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    for (const p of profiles) {
        if (!p.schedule) continue;
        const fromMins = parseHHMM(p.schedule.from);
        const toMins = parseHHMM(p.schedule.to);
        if (fromMins === null || toMins === null) continue;
        const inWindow = fromMins <= toMins
            ? nowMins >= fromMins && nowMins < toMins
            : nowMins >= fromMins || nowMins < toMins;
        if (inWindow) return p;
    }

    // 4. No rule matched — default persona.
    return fallback;
}

function parseHHMM(s: string): number | null {
    const m = /^(\d{2}):(\d{2})$/.exec(s);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
}

// ── Convenience accessors ───────────────────────────────────────────

/**
 * Filter a tool list against the active persona's allowedTools/deniedTools.
 * If no persona is active, returns the input unchanged. If allowedTools is
 * empty (default), only deniedTools applies — i.e. an empty allowlist is
 * "no extra restriction beyond denials."
 */
export function applyPersonaToolFilter<T extends { name?: string; function?: { name: string } }>(
    tools: T[],
    persona: PersonaProfile | null,
): T[] {
    if (!persona) return tools;
    const allowed = new Set(persona.allowedTools);
    const denied = new Set(persona.deniedTools);
    return tools.filter(t => {
        const name = t.name ?? t.function?.name;
        if (!name) return true;
        if (denied.has(name)) return false;
        if (allowed.size > 0 && !allowed.has(name)) return false;
        return true;
    });
}

/**
 * Whether autonomous activity (autopilot ticks, scheduled social posts,
 * background self-mod) should pause right now. Reads the active persona
 * for this moment with no channel/caller context — these daemons run
 * independent of any single request.
 */
export function isWindDownActive(now?: Date): boolean {
    const persona = resolveActivePersona({ now });
    return Boolean(persona?.windDown);
}

/** For diagnostics — used by Mission Control's persona panel. */
export function describeActivePersona(ctx: ResolveContext = {}): {
    enabled: boolean;
    activeId: string | null;
    activeName: string | null;
    windDown: boolean;
    voiceId: string | null;
    reason: string;
} {
    let config: TitanConfig;
    try { config = loadConfig(); } catch { return blank('config load failed'); }
    if (!config.personas?.enabled) return blank('personas.enabled=false');
    const persona = resolveActivePersona(ctx);
    if (!persona) return blank('no persona resolved');

    const reason = explainResolution(config, persona, ctx);
    return {
        enabled: true,
        activeId: persona.id,
        activeName: persona.name,
        windDown: persona.windDown,
        voiceId: persona.voiceId || null,
        reason,
    };
}

function blank(reason: string): ReturnType<typeof describeActivePersona> {
    return { enabled: false, activeId: null, activeName: null, windDown: false, voiceId: null, reason };
}

function explainResolution(config: TitanConfig, persona: PersonaProfile, ctx: ResolveContext): string {
    if (ctx.forceId === persona.id) return `forced via forceId=${ctx.forceId}`;
    if (ctx.channel && config.personas?.channelPins?.[ctx.channel] === persona.id) {
        return `channel pin: ${ctx.channel} → ${persona.id}`;
    }
    if (persona.schedule) {
        return `time window ${persona.schedule.from}–${persona.schedule.to}`;
    }
    return `default persona (${config.personas?.defaultPersona})`;
}
