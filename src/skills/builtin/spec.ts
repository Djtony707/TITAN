/**
 * TITAN — Spec-driven workflow skill (v7.0)
 *
 * Exposes the `spec` tool so the agent (or a human via the API) can author and
 * check a goal's **definition of done**: problem statement, requirements, and
 * testable acceptance criteria. The spec is persisted as `spec.md` next to the
 * goal's `plan.md` and re-injected into the prompt every turn (see
 * `src/agent/goalSpec.ts` + `agent.ts` recency-position wiring).
 *
 * The 2026 spec-engineering loop this enables:
 *   1. `spec` action=define  — write the problem + acceptance criteria up front.
 *   2. … agent does the work, reciting the spec each turn …
 *   3. `spec` action=check   — mark each criterion met/unmet WITH evidence.
 *   4. `spec` action=status  — only "done" when 100% of criteria are `met`.
 *
 * Complements `goalPlanFile` (the step ladder) — spec is "are we there?",
 * plan is "what's next?".
 */
import { registerSkill } from '../registry.js';
import {
    readGoalSpec, writeGoalSpec, setAcceptance, renderSpecMd, specReadiness,
    type GoalSpec, type AcceptanceStatus,
} from '../../agent/goalSpec.js';
import { listSessionGoals } from '../../agent/autonomyContext.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'SpecSkill';

/**
 * Resolve which goal the spec action targets. Explicit `goalId` wins; otherwise
 * auto-resolve when exactly one goal session is active. Returns `{ error }` with
 * guidance when ambiguous so the agent gets a clear next step instead of a throw.
 */
function resolveGoalId(explicit?: string): { goalId?: string; error?: string } {
    if (explicit && explicit.trim()) return { goalId: explicit.trim() };
    const active = listSessionGoals();
    if (active.length === 1) return { goalId: active[0].goalId };
    if (active.length === 0) {
        return { error: 'No active goal to attach a spec to. Pass an explicit "goalId" (the id of the goal/task this spec describes).' };
    }
    const ids = active.map((g) => `${g.goalId} (${g.goalTitle})`).join(', ');
    return { error: `Multiple goals are active — pass an explicit "goalId". Active: ${ids}` };
}

/** Coerce a loose array-of-strings arg (the LLM may send a JSON string). */
function asStringArray(v: unknown): string[] {
    if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.trim().length > 0);
    if (typeof v === 'string' && v.trim()) {
        try { const p = JSON.parse(v); if (Array.isArray(p)) return p.map((x) => String(x)); } catch { /* not json */ }
        return v.split('\n').map((s) => s.replace(/^[-*]\s*/, '').trim()).filter(Boolean);
    }
    return [];
}

export function registerSpecSkill(): void {
    registerSkill(
        { name: 'spec', description: "Author and check a goal's definition-of-done (spec + acceptance criteria)", version: '1.0.0', source: 'bundled', enabled: true },
        {
            name: 'spec',
            description:
                "Spec-driven workflow: write and check a goal's DEFINITION OF DONE (problem, requirements, testable acceptance criteria). The spec is persisted and re-shown to you every turn so you work against it.\n\n" +
                'actions:\n' +
                '• define — create/replace the spec. Args: problem, requirements[], acceptance[] (each a testable statement), constraints[], nonGoals[], title?. Acceptance items auto-get ids ac1, ac2, …\n' +
                '• get — show the current spec (markdown).\n' +
                '• check — mark one acceptance criterion. Args: criterionId (e.g. "ac1"), status ("met"|"unmet"|"unknown"), evidence? (a test name / observation).\n' +
                "• status — readiness rollup (met/total, %). A goal is only DONE when every criterion is 'met'.\n\n" +
                'USE THIS WHEN starting non-trivial work ("define done first"), and before declaring a task complete (check every criterion with evidence). goalId is optional — auto-resolves to the active goal.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['define', 'get', 'check', 'status'], description: 'What to do.' },
                    goalId: { type: 'string', description: 'Goal/task id this spec belongs to. Optional — auto-resolves to the active goal.' },
                    title: { type: 'string', description: '(define) Short title for the spec.' },
                    problem: { type: 'string', description: '(define) One-paragraph problem / desired outcome.' },
                    requirements: { type: 'array', items: { type: 'string' }, description: '(define) What the solution must do.' },
                    acceptance: { type: 'array', items: { type: 'string' }, description: '(define) Testable "done" statements. Auto-ided ac1..acN.' },
                    constraints: { type: 'array', items: { type: 'string' }, description: '(define) Hard limits (perf/security/scope).' },
                    nonGoals: { type: 'array', items: { type: 'string' }, description: '(define) Explicitly out of scope.' },
                    criterionId: { type: 'string', description: '(check) Which acceptance criterion, e.g. "ac1".' },
                    status: { type: 'string', enum: ['met', 'unmet', 'unknown'], description: '(check) New status for the criterion.' },
                    evidence: { type: 'string', description: '(check) How you know — a test name, log line, observation.' },
                },
                required: ['action'],
            },
            execute: async (args: Record<string, unknown>): Promise<string> => {
                const action = String(args.action || '').toLowerCase();
                const { goalId, error } = resolveGoalId(args.goalId as string | undefined);
                if (error) return error;
                const gid = goalId!;

                try {
                    switch (action) {
                        case 'define': {
                            const acceptanceTexts = asStringArray(args.acceptance);
                            const spec: GoalSpec = {
                                goalId: gid,
                                title: String(args.title || readGoalSpec(gid)?.title || gid),
                                problem: String(args.problem || ''),
                                requirements: asStringArray(args.requirements),
                                acceptance: acceptanceTexts.map((text, i) => ({ id: `ac${i + 1}`, text, status: 'unmet' as AcceptanceStatus })),
                                constraints: asStringArray(args.constraints),
                                nonGoals: asStringArray(args.nonGoals),
                                createdAt: readGoalSpec(gid)?.createdAt || new Date().toISOString(),
                                updatedAt: new Date().toISOString(),
                            };
                            writeGoalSpec(spec);
                            const r = specReadiness(spec);
                            return `Spec defined for goal ${gid}: ${spec.acceptance.length} acceptance criteria (${r.met}/${r.total} met). Re-shown each turn — check criteria with action=check as you satisfy them.\n\n${renderSpecMd(spec)}`;
                        }
                        case 'get': {
                            const spec = readGoalSpec(gid);
                            if (!spec) return `No spec exists for goal ${gid} yet. Create one with action=define.`;
                            return renderSpecMd(spec);
                        }
                        case 'check': {
                            const critId = String(args.criterionId || '').trim();
                            const status = String(args.status || '').toLowerCase() as AcceptanceStatus;
                            if (!critId) return 'check requires "criterionId" (e.g. "ac1").';
                            if (!['met', 'unmet', 'unknown'].includes(status)) return 'check requires "status" of met | unmet | unknown.';
                            const spec = readGoalSpec(gid);
                            if (!spec) return `No spec exists for goal ${gid}. Create one with action=define first.`;
                            const updated = setAcceptance(gid, critId, status, args.evidence as string | undefined);
                            if (!updated) {
                                const ids = spec.acceptance.map((a) => a.id).join(', ') || '(none)';
                                return `No criterion "${critId}" in goal ${gid}'s spec. Known criteria: ${ids}.`;
                            }
                            const r = specReadiness(updated);
                            return `Marked ${critId} = ${status}${args.evidence ? ` (evidence: ${args.evidence})` : ''}. Acceptance now ${r.met}/${r.total} met (${r.pct}%).${r.ready ? ' ✅ All criteria met — spec is satisfied.' : ''}`;
                        }
                        case 'status': {
                            const spec = readGoalSpec(gid);
                            if (!spec) return `No spec exists for goal ${gid} yet. Create one with action=define.`;
                            const r = specReadiness(spec);
                            const lines = [`Spec readiness for goal ${gid}: ${r.met}/${r.total} met (${r.pct}%)${r.ready ? ' — ✅ READY' : ''}`];
                            for (const a of spec.acceptance) {
                                const mark = a.status === 'met' ? '✅' : a.status === 'unknown' ? '❓' : '⬜';
                                lines.push(`  ${mark} ${a.id}: ${a.text}${a.evidence ? ` — ${a.evidence}` : ''}`);
                            }
                            if (!r.ready && r.total > 0) lines.push(`\nNOT done — ${r.unmet + r.unknown} criteri${r.unmet + r.unknown === 1 ? 'on' : 'a'} still open.`);
                            return lines.join('\n');
                        }
                        default:
                            return `Unknown spec action "${action}". Use define | get | check | status.`;
                    }
                } catch (e) {
                    logger.warn(COMPONENT, `spec ${action} failed: ${(e as Error).message}`);
                    return `spec ${action} failed: ${(e as Error).message}`;
                }
            },
        },
    );
}
