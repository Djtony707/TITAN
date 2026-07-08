/**
 * Discipline Prompt — the plan-first + escalation habits (v7.2.x).
 *
 * Organs 4 (decompose) and 6 (judgment) of the Fable-5 rebuild plan, delivered
 * as a first-turn system-prompt fragment gated by Reliability Mode. A frontier
 * model plans hard tasks and escalates risky ones by reflex; a weaker local
 * model must be TOLD to. This makes the reflex explicit — so under Reliability
 * Mode a local brain behaves with the same "plan before you build, ask before
 * you do something irreversible" discipline that makes a strong model feel
 * dependable.
 *
 * Pure functions → unit-testable. Fires ONLY when reliabilityMode is on, and
 * the plan-first half only for tasks that look genuinely multi-step (a cheap
 * heuristic — over-injecting on trivial turns would just add noise).
 */

/** Heuristic: does this task look complex enough to warrant planning first? Pure. */
export function looksComplex(message: string): boolean {
    // Cap the scan: complexity shows in the first few KB, and the greedy
    // sequencing regex was measurably quadratic on long single-line inputs
    // (confirmed O(n²) ReDoS: ~3s at 100KB). Bounded input + no greedy `.*`.
    const m = (message || '').trim().slice(0, 4000);
    if (m.length < 40) return false;
    let signals = 0;
    // Sequencing language (linear alternatives only; the old `once .* done`
    // alternative is expressed as two independent word tests).
    if (/\b(then|after that|next|finally|first|second|step \d)\b/i.test(m)
        || (/\bonce\b/i.test(m) && /\bdone\b/i.test(m))) signals++;
    // Explicit multiplicity.
    if (/\band\b.*\band\b/i.test(m)) signals++;
    if (/\b(\d+)\s+(files?|steps?|things?|parts?|tasks?)\b/i.test(m)) signals++;
    // A list of asks IS a decomposable task: 2+ list items → strongly complex.
    const listItems = (m.match(/(^|\n)\s*(\d+[.)]|[-*])\s+\S/gm) || []).length;
    if (listItems >= 2) signals += 2;
    else if (listItems === 1) signals++;
    // Action verbs that usually span files/steps. COUNT them — a task asking
    // for several distinct actions ("build X, integrate Y, and deploy Z") is
    // decomposable even without sequencing words.
    const actionVerbs = (m.match(/\b(refactor|migrate|implement|build|integrate|wire\s?up|set\s?up|deploy|redesign|add|update|create|write|fix|test|configure|install|remove)\b/gi) || []).length;
    if (actionVerbs >= 3) signals += 2;
    else if (actionVerbs >= 1) signals++;
    // Sheer length is itself a weak signal.
    if (m.length > 400) signals++;
    return signals >= 2;
}

const PLAN_FIRST = [
    'DISCIPLINE — plan first: this task looks multi-step. Before calling tools,',
    'write a short numbered plan (the steps and the order). Then execute it,',
    'verifying each step before moving on. Do not claim a step is done until you',
    'have checked it. A plan you followed beats a fast answer you have to redo.',
].join(' ');

const ESCALATE = [
    'DISCIPLINE — escalate the irreversible: before any action that is',
    'destructive (deletes/overwrites data), public (sends/posts/publishes),',
    'spends money, or changes a shared service, STOP and confirm with the user',
    'first unless they already authorized THIS action. Reversible, local work:',
    'proceed. When unsure which, prefer the reversible reading and say so.',
].join(' ');

/**
 * Build the discipline fragment to append to the first-turn system prompt.
 * Returns '' when reliabilityMode is off. Pure.
 */
export function buildDisciplinePrompt(message: string, reliabilityMode: boolean): string {
    if (!reliabilityMode) return '';
    const parts = [ESCALATE]; // escalation discipline always applies under Reliability Mode
    if (looksComplex(message)) parts.unshift(PLAN_FIRST);
    return '\n\n' + parts.join('\n\n');
}
