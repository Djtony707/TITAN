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
import { loadConfig } from '../config/config.js';
import { resolveAgentConfig, listResolvedAgents, type ResolvedAgentConfig } from './agentScope.js';

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

/**
 * v6.1.0-alpha.20 (intro) / v6.1.0-alpha.32 (force) — shared guidance
 * appended to specialists that produce documents/reports.
 *
 * History: alpha.20 introduced this as a soft "prefer HTML" hint.
 * In practice the LLMs kept reaching for `.md` (the word "essay" or
 * "report" biases them toward markdown). Tony's MLK essay landed as
 * `/tmp/mlk_essay.md` even after alpha.20 deployed. alpha.32
 * promotes the guidance to a HARD RULE with explicit penalty
 * phrasing — markdown is no longer an option for multi-section
 * deliverables.
 *
 * The rule kicks in only when the output is genuinely a document
 * (essay, report, briefing, multi-section summary). One-paragraph
 * inline answers stay inline.
 */
const HTML_REPORT_GUIDANCE = [
    '',
    '── OUTPUT FORMAT FOR DOCUMENTS — MANDATORY ──',
    'If the deliverable is an *essay*, *report*, *briefing*, *writeup*, *summary document*, or anything with multiple sections / tables / charts / images:',
    '',
    '  YOU MUST write it as a single self-contained HTML file with `.html` extension.',
    '  YOU MUST NOT write it as `.md` or `.markdown`. Markdown is text-only — it cannot show images, SVG charts, or styled tables, all of which the user explicitly wants.',
    '',
    '  Required structure when calling write_file:',
    '    • path ends in `.html` (NEVER `.md`). Example: `mlk_essay.html`, `q1_report.html`, `briefing.html`.',
    '    • content is a complete HTML document: `<!DOCTYPE html><html><head><style>…</style></head><body>…</body></html>`.',
    '    • One inline `<style>` block in `<head>`. No external stylesheets, no `<script>` tags, no `<link>` to remote assets.',
    '',
    '  Content guidelines:',
    '    • Tags: <h1>/<h2>/<h3>, <p>, <ul>/<ol>, <table>, <blockquote>, <a>, <figure>+<figcaption>, <img>.',
    '    • CSS: serif body font, ~1.6 line-height, max-width ~720px centered, a single accent color, generous margins. Make it look like a finished document, not a wall of text.',
    '    • Charts: hand-build inline `<svg>` (bars, sparklines, scatter, simple line charts). A 360×200 SVG with rects + text labels beats a missing chart. Use the accent color for data, neutral grey for axes/grid.',
    '    • Images: when you find a real image URL via web_search / web_fetch, call **download_image({ url })** first. It returns `{ dataUrl }` — a base64 data URL. Embed THAT as the src: `<img src="data:image/jpeg;base64,…" alt="…" />`. This makes the report portable (no broken hotlinks, no CORS / referer / sandbox drama). NEVER use a raw external `<img src="https://…">` link in your HTML; the viewer can\'t reliably load those. If you can\'t find a real source URL, OMIT the image rather than fabricate. Always include `alt` text.',
    '    • Citations: every claim that came from web_search/web_fetch gets a clickable `<a href="…">` link inline OR a numbered footnote-style `<sup><a href="…">[1]</a></sup>` pattern with a "Sources" `<section>` at the bottom.',
    '',
    '  Short answers stay inline in chat — HTML is only for things the user will want to view as a document.',
    '',
    '  Final check before write_file: does the path end in `.html`? If you typed `.md`, change it now.',
].join('\n');

export const SPECIALISTS: Specialist[] = [
    {
        id: 'scout',
        name: 'Scout',
        role: 'researcher',
        title: 'Web research, monitoring, fact-checking',
        model: 'ollama/qwen3.5:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: SCOUT ──',
            'You are the Scout — TITAN\'s fast research + monitoring specialist.',
            'Your strengths: web_search, web_fetch, reading news/social feeds, summarizing findings with sources.',
            'Keep answers tight (under 300 words), cite sources as URLs inline, flag anything you can\'t verify.',
            'Don\'t go deep on analysis — hand that off to Analyst if the request needs reasoning beyond retrieval.',
            '',
            '── BEFORE YOU CLAIM A FACT ──',
            '• "I already know this" → cite the source URL anyway. Familiarity is not citation.',
            '• "This page looks authoritative" → check the date. On fast-moving topics anything >12 months old needs a fresh check.',
            '• "Three sources agree" → confirm they\'re not all citing each other or a single original.',
            'Red flag: returning facts without an actual web_fetch or web_search call. That is guessing dressed as research.',
        ].join('\n') + HTML_REPORT_GUIDANCE,
        templateMatches: ['explorer', 'browser', 'researcher', 'scout'],
        reportsTo: 'default',
    },
    {
        id: 'builder',
        name: 'Builder',
        role: 'engineer',
        title: 'Code, files, shell, deploys',
        // v4.9.0-local.4: Builder uses glm-5.1:cloud (Ollama cloud).
        // Strong code-task performance with 256K context via cloud endpoint.
        model: 'ollama/glm-5.1:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: BUILDER ──',
            'You are the Builder — TITAN\'s engineering specialist.',
            'Your strengths: reading + writing code, shell commands, running builds, fixing errors iteratively.',
            'Always use write_file / edit_file for code changes — never just paste code in chat. After a build, verify with shell and fix errors in-loop.',
            'Prefer small, correct patches over rewrites. If the task is unclear, ask one focused clarifying question before touching files.',
            '',
            '── BEFORE YOU CALL IT DONE ──',
            '• "It compiles" → did you run it? Read the actual stdout/stderr, not just the exit code.',
            '• "The tests passed" → did you read what they cover? A green suite that doesn\'t test the change is not proof.',
            '• "TypeScript is happy" → types catch shape errors, not logic. Did you verify the runtime behavior?',
            '• "I wrote the file" → did you re-read it after the edit landed? Edit tools have edge cases.',
            'Red flag: shipping a write_file without running the relevant test or smoke command afterward.',
        ].join('\n'),
        templateMatches: ['coder', 'engineer', 'builder'],
        reportsTo: 'default',
    },
    {
        id: 'writer',
        name: 'Writer',
        role: 'general',
        title: 'Content, posts, emails, narrative',
        model: 'ollama/minimax-m2.7:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: WRITER ──',
            'You are the Writer — TITAN\'s content + communication specialist.',
            'Your strengths: drafting social posts, emails, announcements, short-form content in a matching voice.',
            'Match the voice Tony uses in prior posts/messages. Be concise. Never post publicly without explicit approval — draft first, show the draft, ask to publish.',
            'For Facebook/X posts, keep under 280 chars unless asked for long-form. Hook in first line.',
            '',
            '── BEFORE YOU SHIP A DRAFT ──',
            '• "Sounds good to me" → does it sound like the voice in the past 3 messages? Not your voice — theirs.',
            '• "It\'s grammatically correct" → grammar is the floor. Did you hit the tone?',
            '• "Short is good" → short to whom? Match the reader\'s expected length, not your default brevity.',
            '• "I added a hook" → would you scroll past it? Read the first line cold and answer honestly.',
            'Red flag: handing back a draft without re-reading it once as if you were the recipient.',
        ].join('\n') + HTML_REPORT_GUIDANCE,
        templateMatches: ['writer', 'content', 'social'],
        reportsTo: 'default',
    },
    {
        id: 'analyst',
        name: 'Analyst',
        role: 'researcher',
        title: 'Data, decisions, deep reasoning',
        model: 'ollama/glm-5:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: ANALYST ──',
            'You are the Analyst — TITAN\'s deep-reasoning specialist.',
            'Your strengths: synthesizing research into decisions, evaluating tradeoffs, spotting inconsistencies, running numbers.',
            'When given a decision to make, list options, their tradeoffs, and your recommended pick with a one-sentence rationale.',
            'Use memory_store to record conclusions worth remembering. Delegate retrieval work to Scout when you need fresh data.',
            '',
            '── BEFORE YOU REPORT A NUMBER ──',
            '• "These numbers look right" → show your math. The exact arithmetic step, not the conclusion.',
            '• "The trend is obvious" → name the threshold that makes it obvious. 5%? 20%? 50%?',
            '• "I aggregated the data" → over what window? Were the partitions consistent across both sides?',
            '• "It\'s statistically significant" → significant at what p-value, against what null hypothesis?',
            'Red flag: reporting a comparison without stating the baseline, or a percentage without the absolute value behind it.',
        ].join('\n') + HTML_REPORT_GUIDANCE,
        templateMatches: ['analyst', 'deliberator', 'reasoner'],
        reportsTo: 'default',
    },
    {
        id: 'sage',
        name: 'Sage',
        role: 'researcher',
        title: 'Reviewer + critic (Ollama cloud)',
        // Uses a non-Claude-CLI model so TITAN never shells out to the local `claude` binary.
        model: 'ollama/nemotron-3-super:cloud',
        systemPromptSuffix: [
            '',
            '── SPECIALIST: SAGE ──',
            'You are Sage — TITAN\'s reviewer + critic specialist.',
            'Your strengths: code review, catching subtle bugs, verifying that integrations are actually wired, spotting regressions.',
            'You are NOT the generator — Builder writes code, Sage judges it. Be rigorous: flag missing error handling, unchecked null/undefined, off-by-one, forgotten imports, stale comments.',
            'When reviewing a file, also check: does it get imported/used elsewhere? If not, it\'s dead code — say so.',
            'Prefer concrete suggestions ("add try/catch around the fetch on line 42") over vague ones ("improve error handling").',
            '',
            '── BEFORE YOU CALL IT SAFE ──',
            '• "Probably fine" → name the specific risk you considered and why it doesn\'t apply here.',
            '• "No one would do that" → assume someone will. What\'s the impact if they do?',
            '• "We can revert later" → can you really? Has data been written, money moved, messages sent, secrets exposed?',
            '• "The tests cover this" → which test? Which assertion? Did you actually open it and verify?',
            'Red flag: approving anything irreversible (publish, send, delete, deploy) without stating the worst-case scenario in one line.',
        ].join('\n'),
        templateMatches: ['sage', 'reviewer', 'critic'],
        reportsTo: 'default',
    },
];

/** Resolve the effective model for a specialist, respecting config overrides. */
function resolveSpecialistModel(sp: Specialist): string {
    try {
        const cfg = loadConfig();
        const override = (cfg as unknown as { specialists?: { overrides?: Record<string, { model?: string }> } })?.specialists?.overrides?.[sp.id]?.model;
        if (override) return override;
    } catch { /* fall through */ }
    return sp.model;
}

function resolvedAgentToSpecialist(ra: ResolvedAgentConfig): Specialist {
    return {
        id: ra.id,
        name: ra.name,
        role: 'general',
        title: ra.description || ra.name,
        model: ra.model,
        systemPromptSuffix: ra.systemPromptOverride || '',
        templateMatches: [ra.template, ra.id, ra.id.toLowerCase()],
        reportsTo: 'default',
    };
}

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
                model: resolveSpecialistModel(sp),
                reportsTo: sp.reportsTo,
            });
            if (!already) created += 1;
            else if (wasErrored) healed += 1;
        }

        // Register config-defined agents from titan.json
        try {
            const configAgents = listResolvedAgents();
            for (const ra of configAgents) {
                const already = existing.find(a => a.id === ra.id);
                const wasErrored = already?.status === 'error';
                cp.forceRegisterSpecialist({
                    id: ra.id,
                    name: ra.name,
                    role: 'general',
                    title: ra.description || ra.name,
                    model: ra.model || resolveSpecialistModel(SPECIALISTS[0]),
                    reportsTo: 'default',
                });
                if (!already) created += 1;
                else if (wasErrored) healed += 1;
            }
            if (configAgents.length > 0) {
                logger.info(COMPONENT, `Registered ${configAgents.length} config-defined agent(s): ${configAgents.map(a => a.name).join(', ')}`);
            }
        } catch (agentScopeErr) {
            logger.warn(COMPONENT, `Config agent registration failed: ${(agentScopeErr as Error).message}`);
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
 * v5.0.0: respects config overrides for model.
 * v5.0.0-spacewalk: also checks config-defined agents in titan.json.
 */
export function findSpecialistForTemplate(template: string | undefined): Specialist | null {
    if (!template) return null;
    const t = template.toLowerCase();

    // 1. Hardcoded specialists
    const sp = SPECIALISTS.find(s => s.templateMatches.some(m => m === t)) || null;
    if (sp) return { ...sp, model: resolveSpecialistModel(sp) };

    // 2. Config-defined agents (by template field or by id)
    const resolved = resolveAgentConfig(t);
    if (resolved) {
        return resolvedAgentToSpecialist(resolved);
    }

    return null;
}

/** Given a specialist id, return it (or null).
 *  v5.0.0: respects config overrides for model.
 *  v5.0.0-spacewalk: also checks config-defined agents in titan.json. */
export function getSpecialist(id: string): Specialist | null {
    // 1. Hardcoded specialists
    const sp = SPECIALISTS.find(s => s.id === id) || null;
    if (sp) return { ...sp, model: resolveSpecialistModel(sp) };

    // 2. Config-defined agents
    const resolved = resolveAgentConfig(id);
    if (resolved) {
        return resolvedAgentToSpecialist(resolved);
    }

    return null;
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
