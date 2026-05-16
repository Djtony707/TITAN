/**
 * TITAN — Subtask Taxonomy (v4.10.0-local, Phase A)
 *
 * Classifies a subtask into one of 7 kinds so the goalDriver can route
 * it to the right specialist and apply the right verifier.
 *
 * Design notes:
 *   - Heuristic-first: fast, deterministic, no LLM call. ~95% of subtasks
 *     are classifiable by keyword. Only genuinely ambiguous ones need
 *     an LLM classification (not wired yet — that's the "escalate" path).
 *   - Conservative defaults: ambiguous → 'analysis' (cheapest failure mode).
 *     Code is the only kind that mutates files, so we require an explicit
 *     code signal before classifying as 'code'.
 *   - Idempotent: classifying the same subtask twice yields the same kind.
 */
import type { Subtask } from './goals.js';

export type SubtaskKind =
    | 'research'   // fact-finding, web search, exploration
    | 'code'       // write/edit files
    | 'write'      // prose, documentation, reports
    | 'analysis'   // interpret data, structured reasoning
    | 'verify'     // check something is correct
    | 'shell'      // run a command
    | 'report';    // summarize the goal's outcome

// ── Keyword tables ───────────────────────────────────────────────

const CODE_VERBS = [
    'implement', 'write code', 'create file', 'add file',
    'create module', 'create class', 'create function', 'add function',
    'refactor', 'fix bug', 'patch', 'wire up', 'integrate module', 'scaffold',
    'setup endpoint', 'write test', 'add endpoint', 'register handler',
    'port code', 'rewrite module', 'replace implementation', 'migrate code',
    'build module', 'build module for', 'build the module',
];

const RESEARCH_VERBS = [
    'research', 'investigate', 'find out', 'explore', 'discover',
    'look into', 'identify', 'gather', 'survey', 'scan for',
    'search for', 'find references', 'locate', 'enumerate',
    'compile list', 'list known', 'benchmark', 'compare',
];

const WRITE_VERBS = [
    'document', 'write document', 'draft', 'compose', 'author',
    'create documentation', 'write guide', 'write readme',
    'write post', 'write article', 'write spec', 'write proposal',
    'write changelog', 'describe', 'explain in prose',
];

const ANALYSIS_VERBS = [
    'analyze', 'review', 'assess', 'evaluate', 'audit',
    'interpret', 'synthesize', 'summarize findings', 'characterize',
    'classify', 'categorize', 'judge', 'score', 'rate',
    'determine', 'decide between', 'select',
];

const VERIFY_VERBS = [
    'verify', 'validate', 'check', 'confirm', 'test that',
    'ensure', 'assert', 'prove',
];

// v6.1.0-alpha.50 — separated shell verbs into safe-substring and
// strict-boundary lists. Pre-alpha.50 the substring `'rm '` matched
// `"form "` inside `"long-form paper"` (false positive → essay
// classified as `shell`). The two-letter Unix-command tokens
// (`rm`, `ls`, `mv`, `cp`, `cd`) need word-boundary matching.
const SHELL_VERBS_SUBSTRING = [
    'run command', 'execute command', 'run script', 'invoke',
    'run build', 'run tests', 'run npm', 'run bash', 'run shell',
    'chmod', 'mkdir ', 'systemctl', 'restart service', 'kill process',
];
const SHELL_VERBS_BOUNDED = /\b(rm|ls|mv|cp|cd)\s+[^\s]/;

const REPORT_VERBS = [
    'report on', 'summarize goal', 'final report', 'wrap up',
    'produce summary', 'output summary', 'final writeup',
];

// ── Heuristic classifier ─────────────────────────────────────────

function matchAny(hay: string, needles: string[]): boolean {
    const lower = hay.toLowerCase();
    return needles.some(n => lower.includes(n));
}

/**
 * Classify a subtask based on its title + description.
 *
 * Priority order when multiple signals match:
 *   1. code (highest — file writes need scope-locked path)
 *   2. shell (side effects)
 *   3. verify (specific domain)
 *   4. report (end-of-goal marker)
 *   5. research vs write vs analysis by keyword density
 *   6. analysis (default — safe no-op on failure)
 */
export function classifySubtask(subtask: Pick<Subtask, 'title' | 'description'>): SubtaskKind {
    const title = subtask.title.toLowerCase();
    const text = `${subtask.title}\n${subtask.description}`.toLowerCase();

    // Title-level signals win early — the title is the most reliable signal
    // of intent. Description often mentions file paths / tools as examples
    // which should NOT hijack classification.
    if (/\b(verify|validate|confirm|ensure|check that|test that|assert)\b/.test(title)) {
        return 'verify';
    }
    if (/\b(research|investigate|find out|explore|discover|look into|identify|gather|survey|scan for|search for|enumerate|locate|list known)\b/.test(title)) {
        return 'research';
    }
    // v6.1.0-alpha.50 — added `essay|piece|paper|blog|email|letter|
    // note|message|reply|story|review` to the noun list. Pre-alpha.50
    // the regex covered `write a report` / `write a spec` but missed
    // `write a 3 page essay about Martin Luther King` — the latter
    // routed to `analysis` (the no-signal default) and then to the
    // Analyst specialist, which has no `write_file`/`shell` tools
    // and couldn't deliver. The bug was: "write … essay" wasn't in
    // the title-level write regex. Also widened to allow optional
    // length modifiers ("3 page", "short", "long-form", etc.)
    // between `write (a/the)?` and the noun.
    // v6.1.0-alpha.50 — handle hyphenated length-modifiers like
    // `long-form`, `1-paragraph`, `non-fiction` between `write` and
    // the noun. The previous `\w+` didn't match hyphens. Switch to
    // `[\w-]+`. Also accept the noun directly after `write` (no
    // slack) for terse titles like "Write essay".
    if (/\b(document|write(?:\s+[\w-]+){0,4}\s+(?:document|guide|report|spec|post|article|readme|summary|changelog|essay|piece|paper|blog|email|letter|note|message|reply|story|review|memo|brief|writeup|write-up)|draft|compose|author|describe in prose)\b/.test(title)) {
        return 'write';
    }
    if (/\b(analyze|assess|evaluate|audit|interpret|synthesize|categorize|classify|judge|score|decide between|select)\b/.test(title)) {
        return 'analysis';
    }
    if (/\b(run command|execute command|invoke|run script)\b/.test(title)) {
        return 'shell';
    }
    if (/\b(report on|summarize goal|final report|wrap up|produce summary|output summary)\b/.test(title)) {
        return 'report';
    }

    // v4.10.0-local (post-deploy): artifact-producing intent detector.
    // Runs BEFORE the description-level code-verb check because titles
    // like "Design safety metrics dashboard" or "Implement auth endpoint"
    // don't trigger analyze/write/etc heuristics but do produce code.
    // Misclassifying them as `analysis` triggers the prose-marker-strict
    // verifier which rejects successful artifact-producing runs.
    //
    // Requires BOTH an artifact verb AND an artifact-noun (or file path)
    // so we don't hijack genuinely analytical tasks like "design an
    // experiment" where "experiment" isn't a concrete artifact.
    const ARTIFACT_VERBS = /\b(design|implement|build|create|add|generate|produce|integrate|refactor|wire|extract|scaffold|port|migrate|download|embed|save)\b/i;
    const ARTIFACT_NOUNS = /\b(dashboard|panel|endpoint|component|schema|pipeline|hook|module|script|api|handler|route|service|adapter|provider|skill|widget|form|page|watcher|sweeper|manager|layer|middleware|bridge|plugin|resolver|listener|images|file|files|report|essay|document|html|gallery)\b/i;
    if (ARTIFACT_VERBS.test(text) && (ARTIFACT_NOUNS.test(text) || /[\w-]+\.(ts|tsx|js|jsx|py|rs|go|sh|sql|md|yaml|yml)\b/i.test(text))) {
        return 'code';
    }

    // v6.1.0-alpha.57 — Tony's goal "Do a complete and detailed
    // writeup on the advances on AI…" classified as `analysis`
    // because "writeup" only matched as the noun-half of the
    // verb-anchored write regex above. This noun-only pass catches
    // titles that unambiguously name a document type even without a
    // "write/draft/compose" verb. Placed AFTER the ARTIFACT_VERBS
    // code-classifier so code-y titles like "download images and
    // embed in essay" still route to 'code' (the verb signal wins;
    // the noun is incidental). When ARTIFACT_VERBS didn't fire we
    // know the title isn't artifact-producing, so a document noun
    // is the dominant signal.
    if (/\b(writeup|write-up|essay|article|whitepaper|press\s*release|newsletter|op-?ed|briefing)\b/i.test(title)) {
        return 'write';
    }

    // Title didn't have a strong signal — fall through to description-level
    // analysis. Code signals require BOTH a file path AND a code verb — a
    // mere file mention ("check ~/.titan/foo.json for events") is not
    // enough to reclassify as code.
    const hasFilePathSignal = /\/[a-z0-9_\-./]+\.(ts|tsx|js|jsx|py|rs|go|sh|sql|md|yaml|yml)\b/.test(text);
    const hasCodeVerb = matchAny(text, CODE_VERBS);
    const hasWriteFileTool = /\bwrite_file\b|\bedit_file\b|\bapply_patch\b/.test(text);
    // Require BOTH a code verb AND a file/tool signal to classify as code.
    // Mere file mention in prose → NOT code.
    if ((hasCodeVerb && hasFilePathSignal) || hasWriteFileTool) return 'code';

    // Shell mentions — substring set is unambiguous; bounded set
    // is the two-letter Unix commands that need word-boundary check.
    if (matchAny(text, SHELL_VERBS_SUBSTRING) || SHELL_VERBS_BOUNDED.test(text)) return 'shell';

    // Verify in description (title check above handles most)
    if (matchAny(text, VERIFY_VERBS)) return 'verify';

    // End-of-goal report marker
    if (matchAny(text, REPORT_VERBS)) return 'report';

    // Now compete research vs write vs analysis
    const researchScore = RESEARCH_VERBS.filter(v => text.includes(v)).length;
    const writeScore = WRITE_VERBS.filter(v => text.includes(v)).length;
    const analysisScore = ANALYSIS_VERBS.filter(v => text.includes(v)).length;

    const max = Math.max(researchScore, writeScore, analysisScore);
    if (max === 0) return 'analysis'; // no signal — safe default
    if (max === researchScore && researchScore >= writeScore) return 'research';
    if (max === writeScore) return 'write';
    return 'analysis';
}

/**
 * Bulk classify subtasks. Returns a map keyed by subtask id.
 * Called by goalDriver's planning phase.
 */
export function classifyAll(subtasks: Array<Pick<Subtask, 'id' | 'title' | 'description'>>): Record<string, SubtaskKind> {
    const out: Record<string, SubtaskKind> = {};
    for (const s of subtasks) out[s.id] = classifySubtask(s);
    return out;
}

/**
 * Human-readable description of a kind (for logs + UI).
 */
export function describeKind(kind: SubtaskKind): string {
    const descs: Record<SubtaskKind, string> = {
        research: 'Research — fact-finding, web search, exploration',
        code: 'Code — write or edit files',
        write: 'Write — prose, documentation, reports',
        analysis: 'Analysis — interpret data, structured reasoning',
        verify: 'Verify — confirm something is correct',
        shell: 'Shell — run a command',
        report: 'Report — summarize the goal outcome',
    };
    return descs[kind];
}
