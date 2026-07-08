#!/usr/bin/env node
/**
 * extract-sft-dataset.mjs — Rung 1 of the Fable-5 tuning ladder
 * (docs/handoff/REBUILD-FABLE-5.md, Part 2).
 *
 * Converts TITAN's task trajectories (the record of an agent ACTUALLY solving
 * tasks with tools in this codebase) into a supervised fine-tuning dataset:
 * one JSONL line per example, ChatML-style messages, ready for Unsloth LoRA
 * on the 5090 (or any SFT stack).
 *
 * The point: teach a local base model the PROCESS — which tools, in what
 * order, with verification — on Tony's real workloads. Behavioral
 * distillation, not knowledge transfer.
 *
 * Usage:
 *   node scripts/extract-sft-dataset.mjs [--home ~/.titan] [--out sft.jsonl]
 *       [--min-tools 2] [--max-task-chars 2000] [--include-failures]
 *
 * Quality filters (defaults):
 *   - success === true only (verified wins; pass --include-failures to add
 *     failures as negative examples with a critique target instead)
 *   - >= --min-tools tool calls (no-tool chat turns teach nothing about process)
 *   - eval/bench sessions excluded (channel 'eval', sessions starting 'eval-')
 *   - dedup by (taskType + toolSequence signature): keeps the FIRST of each
 *     shape so one over-represented workflow can't dominate the dataset
 */
import { createReadStream, existsSync, writeFileSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { homedir } from 'os';

const args = process.argv.slice(2);
function argOf(flag, dflt) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const TITAN_HOME = argOf('--home', process.env.TITAN_HOME || join(homedir(), '.titan'));
const OUT = argOf('--out', 'sft-dataset.jsonl');
const MIN_TOOLS = Number(argOf('--min-tools', '2'));
const MAX_TASK_CHARS = Number(argOf('--max-task-chars', '2000'));
const INCLUDE_FAILURES = args.includes('--include-failures');

const trajFile = join(TITAN_HOME, 'trajectories', 'task-trajectories.jsonl');
if (!existsSync(trajFile)) {
    console.error(`No trajectory file at ${trajFile} (set --home or TITAN_HOME)`);
    process.exit(1);
}

const SYSTEM = [
    'You are TITAN, a local-first AI agent with tools. Work with discipline:',
    'plan multi-step tasks before acting, verify each step before claiming it,',
    'never state you performed an action unless the tool ran, escalate',
    'destructive or public actions to the user, and finish with an honest',
    'summary of what you did and checked.',
].join(' ');

function signature(t) {
    return `${t.taskType || 'unknown'}::${(t.toolSequence || []).join('>')}`;
}

/**
 * Discipline gate — `success` alone is NOT enough. A marked-success trajectory
 * can still be a flailing session (20 read/list calls hunting for a file).
 * Training on flails teaches flailing. Reject when:
 *   - >25% of tool steps failed, or the FIRST step failed (started blind)
 *   - long sequence with low diversity (≥10 calls but <40% distinct = grinding)
 */
function isDisciplined(t) {
    const seq = t.toolSequence || [];
    const details = t.toolDetails || [];
    if (details.length) {
        const failed = details.filter(d => d.success === false).length;
        if (failed / details.length > 0.25) return false;
        if (details[0]?.success === false) return false;
    }
    if (seq.length >= 10) {
        const distinct = new Set(seq).size;
        if (distinct / seq.length < 0.4) return false;
    }
    return true;
}

/** Render the assistant target: the disciplined process narrative. */
function renderTarget(t) {
    // Real TaskTrajectory shape (trajectoryLogger.ts): toolDetails[] has
    // { name, args, success, resultSnippet }.
    const steps = (t.toolDetails?.length ? t.toolDetails : (t.toolSequence || []).map(n => ({ name: n })))
        .map((d, i) => {
            let arg = '';
            try { if (d.args && Object.keys(d.args).length) arg = `(${JSON.stringify(d.args).slice(0, 120)})`; } catch { /* unserializable */ }
            const out = d.resultSnippet ? ` → ${String(d.resultSnippet).slice(0, 160)}` : '';
            const ok = d.success === false ? ' [FAILED]' : '';
            return `${i + 1}. ${d.name}${arg}${out}${ok}`;
        });
    const plan = steps.length > 1 ? `Plan:\n${steps.map((s, i) => `${i + 1}. ${s.split('(')[0].replace(/^\d+\. /, '')}`).join('\n')}\n\n` : '';
    const shown = steps.slice(0, 12);
    const more = steps.length > shown.length ? `\n… (+${steps.length - shown.length} more steps)` : '';
    const trace = `Execution:\n${shown.join('\n')}${more}`;
    const close = t.success
        ? `\n\nDone — ${t.rounds || 1} round(s), each step verified before the next.`
        : `\n\nThis attempt FAILED. A disciplined agent would have: verified intermediate results before proceeding, and escalated when the second attempt failed.`;
    return `${plan}${trace}${close}`;
}

const rl = createInterface({ input: createReadStream(trajFile, 'utf-8'), crlfDelay: Infinity });
const seen = new Set();
const examples = [];
let total = 0, skippedEval = 0, skippedTools = 0, skippedFail = 0, skippedFlail = 0, deduped = 0;

for await (const line of rl) {
    if (!line.trim()) continue;
    total++;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    const sess = String(t.sessionId || '');
    if (sess.startsWith('eval') || sess.startsWith('bench') || t.channel === 'eval') { skippedEval++; continue; }
    if ((t.toolSequence?.length || 0) < MIN_TOOLS) { skippedTools++; continue; }
    if (!t.success && !INCLUDE_FAILURES) { skippedFail++; continue; }
    if (!isDisciplined(t)) { skippedFlail++; continue; }
    const sig = signature(t);
    if (seen.has(sig)) { deduped++; continue; }
    seen.add(sig);
    const task = String(t.task || '').slice(0, MAX_TASK_CHARS);
    if (!task.trim()) continue;
    examples.push({
        messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: task },
            { role: 'assistant', content: renderTarget(t) },
        ],
        meta: { taskType: t.taskType, tools: t.toolSequence, success: !!t.success, ts: t.timestamp },
    });
}

writeFileSync(OUT, examples.map(e => JSON.stringify(e)).join('\n') + (examples.length ? '\n' : ''));
console.log(JSON.stringify({
    trajectoriesScanned: total,
    examples: examples.length,
    skipped: { evalOrBench: skippedEval, tooFewTools: skippedTools, failures: skippedFail, undisciplinedFlails: skippedFlail, dedupedShapes: deduped },
    out: OUT,
}, null, 2));
