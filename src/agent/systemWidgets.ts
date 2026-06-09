/**
 * TITAN — System-widget shortcut detection + deterministic gate emission.
 *
 * Why this exists (model-agnostic)
 * --------------------------------
 * Short commands like "show backup" / "show recipes" should render a built-in
 * system widget by emitting a `_____widget` gate in the reply. Relying on the
 * LLM to emit that gate is fragile: weaker models read "show backup" as "list
 * backups" and call a tool (e.g. `backup_list`) instead of emitting the gate —
 * so the widget never appears. A model-AGNOSTIC harness must not depend on the
 * model getting this right.
 *
 * This module centralizes the detection (previously inline + too strict in
 * agent.ts — it required a generic widget-noun, so "show backup" never matched)
 * and the canonical gate text, so the agent can:
 *   1. inject a strong instruction when a shortcut is detected (agent.ts), AND
 *   2. GUARANTEE the gate is in the final reply even if the model ignored it
 *      (agent.ts post-loop), regardless of which model is driving.
 */

export interface SystemWidgetMatch {
    /** `system:xxx` source reference for the built-in panel. */
    source: string;
    /** Human-readable widget name. */
    name: string;
}

/** Broad imperative — paired with an explicit widget-noun (e.g. "create a panel"). */
const IMPERATIVE_RE = /\b(?:add|open|show|pin|create|launch|put|display|view|bring\s+up|give\s+me|i\s+want|let'?s\s+see|i\s+need)\b/i;
/** DISPLAY verbs only — used for the short-command path, where there's no
 *  widget-noun to disambiguate. "show/open/view" clearly mean "render it";
 *  "create/add" are excluded there because they often mean an ACTION. */
const DISPLAY_RE = /\b(?:show|open|display|view|pin|launch|bring\s+up|pull\s+up|let'?s\s+see)\b/i;
/** Generic widget nouns — a strong signal even in a longer sentence. */
const WIDGET_NOUN_RE = /\b(?:widget|panel|dashboard|hub|gallery|kitchen|scheduler|monitor)\b/i;
/** File / read / code indicators — these are NOT widget requests even though
 *  they share verbs+keywords ("show me the backup file contents"). */
const NOT_WIDGET_RE = /\b(?:files?|contents?|text|code|source|readme|directory|folder|logs?|\.[a-z]{2,4}\b)\b/i;

/** Specific system widgets + the keywords that name them. Order = priority. */
export const SYSTEM_WIDGET_PATTERNS: Array<{ pattern: RegExp; source: string; name: string }> = [
    { pattern: /\b(?:backups?|snapshots?|archives?)\b/i, source: 'system:backup', name: 'Backup Manager' },
    { pattern: /\b(?:training|train|specialists?|models?)\b/i, source: 'system:training', name: 'Training Dashboard' },
    { pattern: /\b(?:recipes?|playbooks?|workflows?|jarvis)\b/i, source: 'system:recipes', name: 'Recipe Kitchen' },
    { pattern: /\b(?:vram|gpu|nvidia)\b/i, source: 'system:vram', name: 'VRAM Monitor' },
    { pattern: /\b(?:teams?|members?|roles?|permissions?|rbac)\b/i, source: 'system:teams', name: 'Team Hub' },
    { pattern: /\b(?:cron|schedules?|jobs?|timers?)\b/i, source: 'system:cron', name: 'Cron Scheduler' },
    { pattern: /\b(?:checkpoints?|restores?|save\s+state)\b/i, source: 'system:checkpoints', name: 'Checkpoints' },
    { pattern: /\b(?:organism|guardrails?)\b/i, source: 'system:organism', name: 'Organism Monitor' },
    { pattern: /\b(?:fleet|nodes?|routes?|mesh)\b/i, source: 'system:fleet', name: 'Fleet Router' },
    { pattern: /\b(?:browser|captcha|form\s+fill|web\s+automation)\b/i, source: 'system:browser', name: 'Browser Tools' },
    { pattern: /\b(?:flaky|failing|coverage|test\s+lab|evals?)\b/i, source: 'system:eval', name: 'Test Lab' },
];

/**
 * Detect a system-widget shortcut request. Returns the matched widget or null.
 *
 * Fires when the message has an imperative verb AND either:
 *   (a) a generic widget-noun (e.g. "show the training dashboard"), OR
 *   (b) it's a SHORT command (≤6 words) that names a specific system widget
 *       (e.g. "show backup", "show recipes") — the case the old inline check
 *       missed because it demanded a generic widget-noun.
 *
 * The short-command guard prevents hijacking longer task sentences ("show me
 * how to back up the database to S3" → not a widget request).
 */
export function detectSystemWidget(message: string): SystemWidgetMatch | null {
    if (!message || typeof message !== 'string') return null;
    // A file/read/code request is never a widget shortcut, even if it shares a
    // verb + keyword ("show me the backup file contents").
    if (NOT_WIDGET_RE.test(message)) return null;
    const wordCount = message.trim().split(/\s+/).filter(Boolean).length;
    const hasWidgetIntent =
        // (a) explicit widget-noun anywhere ("show the training dashboard").
        (IMPERATIVE_RE.test(message) && WIDGET_NOUN_RE.test(message)) ||
        // (b) a SHORT display command that names a system widget ("show backup").
        (DISPLAY_RE.test(message) && wordCount <= 6);
    if (!hasWidgetIntent) return null;
    const m = SYSTEM_WIDGET_PATTERNS.find((p) => p.pattern.test(message));
    return m ? { source: m.source, name: m.name } : null;
}

/** Build the canonical `_____widget` gate text for a system widget. */
export function buildSystemWidgetGate(w: SystemWidgetMatch, size: { w: number; h: number } = { w: 6, h: 6 }): string {
    return `_____widget\n{ "name": "${w.name}", "format": "system", "source": "${w.source}", "w": ${size.w}, "h": ${size.h} }`;
}
