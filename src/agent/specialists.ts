/**
 * TITAN — Specialist Agent Pool (v4.6.3+)
 *
 * A curated set of pre-registered specialist agents that the primary
 * (TITAN) delegates to via the spawn_agent tool. Having them registered
 * (vs spawned ad-hoc) gives:
 *   - Visibility in Org Chart + Agents tab
 *   - Per-agent budgets (runaway Scout doesn't drain Builder's budget)
 *   - Consistent identity across tasks (same Scout every time)
 *   - Role-appropriate models + system prompts
 *
 * Tony can add/remove/edit these via the Agents tab. This module just
 * guarantees the default pool exists on startup.
 */
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from '../utils/logger.js';

// Resolve the repo's assets/role-bundles directory whether we're running
// from dist/ or src/ (tsx dev mode). At build time tsup bundles this file
// into dist/... and assets/ lives as a sibling at dist/../assets/.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const COMPONENT = 'Specialists';

export interface Specialist {
    /** Stable ID — used as agentId in Command Post + spawn_agent routing */
    id: string;
    /** Human-readable name shown in Org Chart */
    name: string;
    /** Command Post role */
    role: 'manager' | 'ceo' | 'engineer' | 'researcher' | 'general';
    /** One-line role description — shown under Name in Org Chart */
    title: string;
    /** Preferred model for this specialist. Primary falls back if unavailable. */
    model: string;
    /** Appended to the global system prompt when this specialist runs */
    systemPromptSuffix: string;
    /**
     * spawn_agent template names that should route to this specialist.
     * When the primary agent calls spawn_agent({ template: 'explorer' }),
     * the router picks the specialist whose templateMatches contains it.
     */
    templateMatches: string[];
    /** Reports-to for Org Chart hierarchy. 'default' = TITAN Primary. */
    reportsTo: string;
}

export const SPECIALISTS: Specialist[] = [
    {
        id: 'scout',
        name: 'Scout',
        role: 'researcher',
        title: 'Web research, monitoring, fact-checking',
        model: 'ollama/gemini-3-flash-preview:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: SCOUT ──',
            'You are the Scout — TITAN\'s fast research + monitoring specialist.',
            'Your strengths: web_search, web_fetch, reading news/social feeds, summarizing findings with sources.',
            'Keep answers tight (under 300 words), cite sources as URLs inline, flag anything you can\'t verify.',
            'Don\'t go deep on analysis — hand that off to Analyst if the request needs reasoning beyond retrieval.',
        ].join('\n'),
        templateMatches: ['explorer', 'browser', 'researcher', 'scout'],
        reportsTo: 'default',
    },
    {
        id: 'builder',
        name: 'Builder',
        role: 'engineer',
        title: 'Code, files, shell, deploys',
        model: 'ollama/glm-5.1:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: BUILDER ──',
            'You are the Builder — TITAN\'s engineering specialist.',
            'Your strengths: reading + writing code, shell commands, running builds, fixing errors iteratively.',
            'Always use write_file / edit_file for code changes — never just paste code in chat. After a build, verify with shell and fix errors in-loop.',
            'Prefer small, correct patches over rewrites. If the task is unclear, ask one focused clarifying question before touching files.',
        ].join('\n'),
        templateMatches: ['coder', 'engineer', 'builder'],
        reportsTo: 'default',
    },
    {
        id: 'writer',
        name: 'Writer',
        role: 'general',
        title: 'Content, posts, emails, narrative',
        model: 'ollama/glm-5.1:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: WRITER ──',
            'You are the Writer — TITAN\'s content + communication specialist.',
            'Your strengths: drafting social posts, emails, announcements, short-form content in a matching voice.',
            'Match the voice Tony uses in prior posts/messages. Be concise. Never post publicly without explicit approval — draft first, show the draft, ask to publish.',
            'For Facebook/X posts, keep under 280 chars unless asked for long-form. Hook in first line.',
        ].join('\n'),
        templateMatches: ['writer', 'content', 'social'],
        reportsTo: 'default',
    },
    {
        id: 'analyst',
        name: 'Analyst',
        role: 'researcher',
        title: 'Data, decisions, deep reasoning',
        model: 'ollama/glm-5.1:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: ANALYST ──',
            'You are the Analyst — TITAN\'s deep-reasoning specialist.',
            'Your strengths: synthesizing research into decisions, evaluating tradeoffs, spotting inconsistencies, running numbers.',
            'When given a decision to make, list options, their tradeoffs, and your recommended pick with a one-sentence rationale.',
            'Use memory_store to record conclusions worth remembering. Delegate retrieval work to Scout when you need fresh data.',
        ].join('\n'),
        templateMatches: ['analyst', 'deliberator', 'reasoner'],
        reportsTo: 'default',
    },
];

/**
 * Ensure all specialists are registered with Command Post. Idempotent —
 * safe to call multiple times. Runs on gateway startup.
 */
export async function ensureSpecialistsRegistered(): Promise<void> {
    try {
        const cp = await import('./commandPost.js');
        const existing = cp.getRegisteredAgents();
        let created = 0;
        let healed = 0;
        for (const sp of SPECIALISTS) {
            const already = existing.find(a => a.id === sp.id);
            // v4.8.1: always call forceRegisterSpecialist — it's idempotent
            // AND it self-heals specialists stuck in 'error' from the
            // pre-v4.8.1 stale-heartbeat bug. Short-circuiting on `already`
            // skipped the heal path.
            const wasErrored = already?.status === 'error';
            cp.forceRegisterSpecialist({
                id: sp.id,
                name: sp.name,
                role: sp.role,
                title: sp.title,
                model: sp.model,
                reportsTo: sp.reportsTo,
            });
            if (!already) created += 1;
            else if (wasErrored) healed += 1;
        }
        if (created > 0) logger.info(COMPONENT, `Registered ${created} specialist(s): ${SPECIALISTS.map(s => s.name).join(', ')}`);
        if (healed > 0) logger.info(COMPONENT, `Healed ${healed} specialist(s) from stuck 'error' state → 'idle'`);
    } catch (err) {
        logger.warn(COMPONENT, `Specialist registration failed: ${(err as Error).message}`);
    }
}

/**
 * Given a spawn_agent template hint, find the best-matching specialist.
 * Returns null if no match — callers fall back to the generic spawn path.
 */
export function findSpecialistForTemplate(template: string | undefined): Specialist | null {
    if (!template) return null;
    const t = template.toLowerCase();
    return SPECIALISTS.find(s => s.templateMatches.some(m => m === t)) || null;
}

/** Given a specialist id, return it (or null). */
export function getSpecialist(id: string): Specialist | null {
    return SPECIALISTS.find(s => s.id === id) || null;
}

/**
 * Load a specialist's SOUL.md from assets/role-bundles/<id>/SOUL.md.
 * Returns the inline systemPromptSuffix as a fallback if the bundle file
 * isn't found (e.g., running from a packaged install without assets).
 */
export function loadSpecialistPersona(id: string): string {
    const specialist = getSpecialist(id);
    if (!specialist) return '';
    // Try a few candidate paths to find the bundle file:
    const candidates = [
        join(__dirname, '..', '..', 'assets', 'role-bundles', id, 'SOUL.md'),
        join(__dirname, '..', '..', '..', 'assets', 'role-bundles', id, 'SOUL.md'),
        join(process.cwd(), 'assets', 'role-bundles', id, 'SOUL.md'),
    ];
    for (const path of candidates) {
        try {
            if (existsSync(path)) return readFileSync(path, 'utf-8').trim();
        } catch { /* next */ }
    }
    return specialist.systemPromptSuffix;
}
