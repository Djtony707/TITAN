/**
 * TITAN — somaInitiative (v6.0 step 11)
 *
 * Why this exists
 * ---------------
 * The Presence thesis: "TITAN acts without being asked." This module is the
 * concrete engine. While the user is idle, a cron-driven scout fires every
 * N minutes:
 *
 *   1. Read the user's pattern aggregates (step 12)
 *   2. Read Soma drive state (step 14 + organism layer)
 *   3. Read time-of-day, recent activity, pending todos
 *   4. Decide if there's a useful surface to surface
 *   5. If yes — fire a side-channel widget event (existing widgetEmitter)
 *      labelled "Soma noticed…" so the user sees it appeared
 *      autonomously
 *
 * Most pulses end in "nothing to do." That's by design — the loop is
 * conservative. Better to miss a chance to help than spam the user with
 * unwanted widgets.
 *
 * Reference:
 *   - ~/.claude/projects/-Users-localuser/memory/titan-v6-living-canvas.md
 *     (v6.0 step 11)
 *   - src/storage/patterns.ts — input signals
 *   - src/storage/somaProfile.ts — drive baselines
 *   - src/agent/widgetEmitter.ts — output channel
 */
import logger from '../utils/logger.js';
import { deriveSuggestions, recordSignal, aggregatePatterns } from '../storage/patterns.js';
import { readSomaProfile } from '../storage/somaProfile.js';
import { getActiveSpace } from '../storage/spaces.js';

const COMPONENT = 'SomaInitiative';

/** How often the loop fires when active. 5 minutes by Tony's spec. */
const PULSE_INTERVAL_MS = 5 * 60 * 1000;

/** Time-of-day buckets the heuristics check against (24h, local). */
function timeBucket(now = new Date()): string {
    const hour = now.getHours();
    const day = now.getDay();
    const dayKind = day === 0 || day === 6 ? 'weekend' : 'weekday';
    return `${dayKind}-${hour.toString().padStart(2, '0')}`;
}

/** Single pulse — pure function of inputs, no side effects yet. */
export interface PulseDecision {
    /** What the loop decided to do this pulse. */
    action: 'nothing' | 'pin-widget' | 'create-space' | 'add-cron' | 'note';
    /** Human-readable explanation (used in logs + the `Soma noticed…` chip). */
    rationale?: string;
    /** Confidence the suggestion is welcome (0..1). */
    confidence?: number;
    /** Optional payload for the action — varies by kind. */
    payload?: Record<string, unknown>;
}

/**
 * Decide what (if anything) Soma should do this pulse. Pure function — no
 * side effects. The actual emission happens in `executePulse`.
 *
 * Inputs:
 *   - userId — whose patterns/profile to read
 *   - idleMs — milliseconds since last user activity
 *   - opts.minIdleMs — only act when truly idle (default 2 min)
 */
export function decidePulse(
    userId = 'default-user',
    idleMs = Infinity,
    opts?: { minIdleMs?: number },
): PulseDecision {
    const minIdle = opts?.minIdleMs ?? 2 * 60 * 1000;
    if (idleMs < minIdle) {
        return { action: 'nothing', rationale: 'user is active' };
    }

    // Record the time bucket as a pattern signal so the loop's own activity
    // becomes part of the user's pattern history. This is harmless and
    // helps timing-based suggestions emerge over time.
    recordSignal(userId, `time:${timeBucket()}`);

    const suggestions = deriveSuggestions(userId, { windowDays: 14 });
    if (suggestions.length === 0) {
        return { action: 'nothing', rationale: 'no patterns above confidence threshold' };
    }

    // Pick the single highest-confidence suggestion. Future iterations could
    // surface multiple, but conservative-first is the right default.
    const best = suggestions.sort((a, b) => b.confidence - a.confidence)[0];

    // Don't suggest the same thing repeatedly — dedup on signal in pattern
    // history. We rely on the pattern aggregation cooldown (only suggests
    // when count >= 3 in window) as the primary throttle; here we layer a
    // small extra check using the active Space's frustration baseline.
    const profile = readSomaProfile(userId);
    if (profile.baseline.frustration > 0.7) {
        // User has been frustrated. Don't pile on with proactive suggestions
        // — they'll feel like noise. Wait for the frustration to subside.
        return { action: 'nothing', rationale: 'soma frustration high — holding suggestions' };
    }

    return {
        action: best.kind === 'pin-widget' ? 'pin-widget'
              : best.kind === 'create-space' ? 'create-space'
              : best.kind === 'add-cron' ? 'add-cron'
              : 'note',
        rationale: best.rationale,
        confidence: best.confidence,
        payload: { signal: best.signal, activeSpaceId: getActiveSpace()?.id },
    };
}

/**
 * Fire one pulse + execute its decision. Used both by the cron driver and
 * by tests to step the loop deterministically.
 *
 * Returns the decision for telemetry / test assertions.
 */
export function executePulse(userId = 'default-user', idleMs = Infinity): PulseDecision {
    const d = decidePulse(userId, idleMs);
    if (d.action === 'nothing') {
        // Don't log every "nothing happened" tick — too noisy.
        return d;
    }
    logger.info(COMPONENT, `[Pulse] action=${d.action} confidence=${d.confidence?.toFixed(2)} rationale="${d.rationale}"`);

    // For now the loop emits a logged advisory rather than auto-creating
    // widgets. Auto-creation requires:
    //   - the gateway SSE stream to be open (otherwise the widget event
    //     fires into the void)
    //   - the agent to author the actual widget code, which it can't do
    //     from a non-LLM context
    //
    // The right next step (v6.0+) is to enqueue these advisories so the
    // user sees them in a "Soma noticed…" panel; the agent's NEXT chat
    // turn can then pick them up and act. That keeps the loop's
    // side-effects observable + reversible.
    enqueueAdvisory(userId, d);
    return d;
}

// ─── Advisory queue ─────────────────────────────────────────────────

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function advisoriesPath(userId: string): string {
    const env = process.env.TITAN_HOME;
    const home = env
        ? (env.startsWith('~/') ? join(homedir(), env.slice(2)) : env)
        : join(homedir(), '.titan');
    return join(home, 'users', userId, 'soma-advisories.jsonl');
}

// v6.0.2 — Advisory dedup + retention windows.
//
// Pre-v6.0.2, `enqueueAdvisory` blindly appended every pulse decision.
// Since `decidePulse` is stable (same activity pattern → same advisory)
// the file accumulated hundreds of duplicate entries — 308 in production
// at the time this fix shipped, of which only ~10 were unique. The
// SomaAdvisoryToast widget polls this file and surfaces "new" entries,
// so duplicates re-spam the user with the same suggestion every 30s.
//
// Fix: before appending, check whether the same (action, rationale) pair
// was filed within `ADVISORY_DEDUP_WINDOW_MS` (12h default). If yes,
// silently skip. ALSO prune entries older than `ADVISORY_RETENTION_MS`
// (7 days) on every write so the file doesn't grow unbounded.
//
// Override either window via env (TITAN_SOMA_DEDUP_WINDOW_MS /
// TITAN_SOMA_ADVISORY_RETENTION_MS) for testing or aggressive tuning.

const DEFAULT_DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7d

function getDedupWindowMs(): number {
    const raw = process.env.TITAN_SOMA_DEDUP_WINDOW_MS;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DEDUP_WINDOW_MS;
}

function getRetentionMs(): number {
    const raw = process.env.TITAN_SOMA_ADVISORY_RETENTION_MS;
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETENTION_MS;
}

interface AdvisoryRecord {
    at: string;
    action: string;
    rationale: string;
    confidence: number;
    payload?: Record<string, unknown>;
}

function parseAdvisoryFile(raw: string): AdvisoryRecord[] {
    if (!raw.trim()) return [];
    const out: AdvisoryRecord[] = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const rec = JSON.parse(trimmed) as AdvisoryRecord;
            if (rec && typeof rec.at === 'string' && typeof rec.action === 'string') out.push(rec);
        } catch { /* skip corrupt line — never let one bad row break dedup */ }
    }
    return out;
}

/** Normalize rationale so trivial variations (whitespace, capitalization,
 *  trailing punctuation) collapse to the same dedup key. */
function dedupKey(action: string, rationale: string): string {
    const r = rationale.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+\s*$/, '').trim();
    return `${action}::${r}`;
}

export function enqueueAdvisory(userId: string, decision: PulseDecision, now: number = Date.now()): void {
    if (decision.action === 'nothing') return;
    const path = advisoriesPath(userId);
    try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }

    // Normalize optionals up-front so dedup + persistence work with
    // concrete values (PulseDecision.rationale/confidence are optional
    // on the type, but every advisory needs a stable form on disk).
    const rationale = (decision.rationale ?? '').trim() || decision.action;
    const confidence = typeof decision.confidence === 'number' && Number.isFinite(decision.confidence) ? decision.confidence : 0.5;

    const dedupWindow = getDedupWindowMs();
    const retention = getRetentionMs();
    const incomingKey = dedupKey(decision.action, rationale);

    try {
        const existing = existsSync(path) ? parseAdvisoryFile(readFileSync(path, 'utf-8')) : [];

        // Prune entries older than retention so the file stays bounded.
        const retentionCutoff = now - retention;
        const retained = existing.filter(r => {
            const t = new Date(r.at).getTime();
            return Number.isFinite(t) && t >= retentionCutoff;
        });

        // Dedup: same (action, normalized-rationale) within the dedup window → skip.
        const dedupCutoff = now - dedupWindow;
        const isDup = retained.some(r => {
            const t = new Date(r.at).getTime();
            if (!Number.isFinite(t) || t < dedupCutoff) return false;
            return dedupKey(r.action, r.rationale) === incomingKey;
        });
        if (isDup) {
            // Common case during a steady-state behaviour pattern. Don't
            // spam the agent log either — debug level only.
            logger.debug(COMPONENT, `Skipping duplicate advisory within ${Math.round(dedupWindow / 3600_000)}h window: ${decision.action} — ${rationale.slice(0, 60)}`);
            // Rewrite the pruned file IF we actually pruned anything, so
            // the retention sweep still happens even when we're deduping.
            if (retained.length !== existing.length) {
                const body = retained.map(r => JSON.stringify(r)).join('\n') + (retained.length > 0 ? '\n' : '');
                writeFileSync(path, body);
            }
            return;
        }

        // New advisory — append.
        const fresh: AdvisoryRecord = {
            at: new Date(now).toISOString(),
            action: decision.action,
            rationale,
            confidence,
            payload: decision.payload,
        };
        const final = [...retained, fresh];
        const body = final.map(r => JSON.stringify(r)).join('\n') + '\n';
        writeFileSync(path, body);
        if (retained.length !== existing.length) {
            logger.info(COMPONENT, `Pruned ${existing.length - retained.length} stale advisory entries (>${Math.round(retention / 86400_000)}d old)`);
        }
    } catch (err) {
        logger.warn(COMPONENT, `Failed to enqueue advisory: ${(err as Error).message}`);
    }
}

/** Read recent advisories. Used by the agent loop to surface Soma's
 *  observations in the next chat turn. Returns up to `limit` most-recent. */
export function readRecentAdvisories(userId: string, limit = 5): Array<{
    at: string;
    action: string;
    rationale: string;
    confidence: number;
    payload?: Record<string, unknown>;
}> {
    const path = advisoriesPath(userId);
    if (!existsSync(path)) return [];
    try {
        const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
        return lines.slice(-limit).map(l => JSON.parse(l)).reverse();
    } catch {
        return [];
    }
}

// ─── Daily proactive-widget gift (v6.0) ────────────────────────────
//
// Tony's spec: "I want the TITAN agent to make a customized widget for
// its user, from info it knows about the user, every day or so if it
// wants to."
//
// Mechanism:
//   1. Once a day (default — 22h interval, slight jitter), the agent
//      considers gifting the user a custom widget.
//   2. Pulls the user's Soma profile (long-term observations + baseline
//      drives), recent patterns, and active Space context.
//   3. Composes a /api/message internal prompt asking the agent to
//      "design and pin a widget you think the user would appreciate
//      based on what you know about them — or skip if nothing comes to
//      mind." Conservative bias: the agent SHOULD skip when in doubt.
//   4. The agent (real LLM) either calls create_widget itself or
//      politely declines. Either way the decision is logged to
//      `~/.titan/users/<userId>/soma-gifts.jsonl` so we can audit.
//
// This is the "TITAN gifts you a widget on its own, occasionally"
// behavior — different from the 5-min advisory pulse which only files
// advisories without calling the LLM.

const DAILY_GIFT_INTERVAL_MS = 22 * 60 * 60 * 1000; // 22h, lets it drift
const DAILY_GIFT_MIN_GAP_MS = 18 * 60 * 60 * 1000;  // never less than 18h between gifts

function giftsPath(userId: string): string {
    const env = process.env.TITAN_HOME;
    const home = env
        ? (env.startsWith('~/') ? join(homedir(), env.slice(2)) : env)
        : join(homedir(), '.titan');
    return join(home, 'users', userId, 'soma-gifts.jsonl');
}

/** Read the most recent gift attempt timestamp (epoch ms), or 0 if none. */
function lastGiftAt(userId: string): number {
    const path = giftsPath(userId);
    if (!existsSync(path)) return 0;
    try {
        const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean);
        const last = lines[lines.length - 1];
        if (!last) return 0;
        const entry = JSON.parse(last) as { at?: string };
        return entry.at ? Date.parse(entry.at) : 0;
    } catch { return 0; }
}

function logGiftAttempt(userId: string, payload: Record<string, unknown>): void {
    const path = giftsPath(userId);
    try { mkdirSync(join(path, '..'), { recursive: true }); } catch { /* exists */ }
    const line = JSON.stringify({ at: new Date().toISOString(), ...payload });
    try {
        const prev = existsSync(path) ? readFileSync(path, 'utf-8') : '';
        writeFileSync(path, prev + line + '\n');
    } catch (err) {
        logger.warn(COMPONENT, `gift log write failed: ${(err as Error).message}`);
    }
}

/**
 * Decide whether to gift a custom widget today. Pure function — no side
 * effects. Returns null when we should NOT gift right now, or an object
 * with a one-paragraph brief the LLM can use to design the widget.
 */
export interface GiftBrief {
    /** Short rationale shown to the user when the widget lands. */
    rationale: string;
    /** Compact context the LLM sees — recent observations + patterns. */
    context: string;
}

export function decideDailyGift(userId = 'default-user', now = Date.now(), opts?: { force?: boolean }): GiftBrief | null {
    const force = opts?.force === true;
    if (!force) {
        const since = now - lastGiftAt(userId);
        if (since < DAILY_GIFT_MIN_GAP_MS) return null;
    }

    // Pull what we know about the user.
    const profile = readSomaProfile(userId);
    // v6.0.3 — When force=true (manual user trigger from the SOMA panel),
    // skip the "learned >= 3 observations" gate. The user explicitly asked
    // for a gift; Soma should at least try, even on day-one with a thin
    // profile. The agent prompt still lets the LLM decline if nothing
    // meaningful comes to mind.
    if (!force && profile.learnedAboutUser.length < 3) {
        return null;
    }
    // Don't gift when frustrated — same throttling as advisories.
    // Manual trigger overrides this too.
    if (!force && profile.baseline.frustration > 0.7) return null;

    const recent = profile.learnedAboutUser.slice(-10);
    const aggs = aggregatePatterns(userId, { windowDays: 7, topN: 5 });
    const activeSpace = getActiveSpace();

    const context = [
        `User profile (most recent 10 observations):`,
        ...recent.map(o => `  - ${o}`),
        ``,
        `Top patterns last 7 days:`,
        ...(aggs.length === 0
            ? ['  (none yet — user is new or quiet)']
            : aggs.map(a => `  - ${a.signal} ×${a.count}`)),
        ``,
        activeSpace ? `Active Space: ${activeSpace.name} (${activeSpace.widgets.length} widget(s) pinned).` : 'No active Space.',
    ].join('\n');

    return {
        rationale: `Soma noticed it's been ~24h since the last surprise. Generating a widget from what's known about the user.`,
        context,
    };
}

/**
 * Actually execute the daily gift — invokes the LLM via the agent's own
 * `processMessage` flow with a brief that asks the agent to either build
 * a widget or politely decline. The agent's create_widget call (if it
 * makes one) routes through the normal widgetEmitter side-channel.
 */
export async function tryDailyGift(userId = 'default-user', opts?: { force?: boolean }): Promise<{ attempted: boolean; reason: string }> {
    const brief = decideDailyGift(userId, Date.now(), opts);
    if (!brief) {
        return { attempted: false, reason: 'cooldown / not enough profile / soma blocked' };
    }
    logger.info(COMPONENT, `[DailyGift] attempting for ${userId}`);
    logGiftAttempt(userId, { phase: 'start' });

    const prompt = [
        `You have an opportunity to gift the user a custom widget right now.`,
        `This is a SPONTANEOUS, OPTIONAL gesture — not a response to a request.`,
        `Decline if nothing meaningful comes to mind. Better to skip than to ship something generic.`,
        ``,
        `What you know about THIS user:`,
        brief.context,
        ``,
        `If you decide to build, call \`create_widget\` ONCE with a name + source that genuinely reflects something specific to this user (a tracker for a thing they care about, a tool for a recurring task, a dashboard for a domain they work in). Title it something they'd recognize as personal.`,
        ``,
        `If you decline, just reply with one sentence explaining why ("nothing strong enough today"). Do NOT make excuses, do NOT promise a future gift.`,
    ].join('\n');

    try {
        // Lazy-import to avoid circular deps at module load.
        const { processMessage } = await import('./agent.js');
        const result = await processMessage(prompt, 'soma-initiative', userId, {});
        const toolCalls = (result.toolsUsed || []).join(', ');
        const widgetMade = (result.toolsUsed || []).includes('create_widget');
        logGiftAttempt(userId, {
            phase: 'done',
            widgetMade,
            toolsUsed: toolCalls,
            content: (result.content || '').slice(0, 240),
        });
        logger.info(COMPONENT, `[DailyGift] ${widgetMade ? 'built a widget' : 'declined'} (tools: ${toolCalls})`);
        return { attempted: true, reason: widgetMade ? 'widget shipped' : 'agent declined' };
    } catch (err) {
        logGiftAttempt(userId, { phase: 'error', error: (err as Error).message });
        logger.warn(COMPONENT, `[DailyGift] error: ${(err as Error).message}`);
        return { attempted: false, reason: `error: ${(err as Error).message}` };
    }
}

// ─── Driver ────────────────────────────────────────────────────────

let timerHandle: NodeJS.Timeout | null = null;
let dailyGiftHandle: NodeJS.Timeout | null = null;

/** Start the cron-driven pulse loop. Idempotent. */
export function startSomaInitiative(opts?: { intervalMs?: number; userId?: string; dailyGiftIntervalMs?: number }): void {
    if (timerHandle) return;
    const interval = opts?.intervalMs ?? PULSE_INTERVAL_MS;
    const userId = opts?.userId ?? 'default-user';

    timerHandle = setInterval(() => {
        try {
            // Idle detection is approximate — for now we treat every tick as
            // "fully idle" and let `decidePulse`'s conservative confidence
            // threshold do the throttling. Once gateway-side idle tracking
            // wires in (e.g. last /api/message timestamp), this can be
            // replaced with a real `idleMs`.
            executePulse(userId, Infinity);
        } catch (err) {
            logger.warn(COMPONENT, `Pulse error: ${(err as Error).message}`);
        }
    }, interval);
    if (timerHandle.unref) timerHandle.unref();
    logger.info(COMPONENT, `Started somaInitiative loop (interval=${Math.round(interval / 1000)}s, user=${userId}).`);

    // v6.0 — Daily proactive-widget gift loop. Fires once every
    // ~22h with jitter; the cooldown check inside decideDailyGift also
    // prevents over-firing if interval is short. Independent timer so
    // its long cadence doesn't gum up the 5-min advisory pulse.
    const giftInterval = opts?.dailyGiftIntervalMs ?? DAILY_GIFT_INTERVAL_MS;
    dailyGiftHandle = setInterval(() => {
        void tryDailyGift(userId);
    }, giftInterval);
    if (dailyGiftHandle.unref) dailyGiftHandle.unref();
    logger.info(COMPONENT, `Started daily-gift loop (interval=${Math.round(giftInterval / 3600_000)}h, user=${userId}).`);
}

export function stopSomaInitiative(): void {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
    if (dailyGiftHandle) { clearInterval(dailyGiftHandle); dailyGiftHandle = null; }
}

export function __resetForTests(): void {
    stopSomaInitiative();
}
