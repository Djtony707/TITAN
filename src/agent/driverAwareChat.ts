/**
 * TITAN — Driver-Aware Chat (v4.10.0-local, Phase B)
 *
 * Hooks into the agent's processMessage prompt so that when Tony asks
 * status questions ("what are you working on?", "any blockers?", "status"),
 * TITAN responds with REAL current state from live drivers — not
 * hallucinated recall from episodic memory.
 *
 * Exposed as a system-prompt block via `renderDriverStatusBlock()`.
 * The agent loop includes this block when the user's message matches
 * status-query patterns.
 */
import { listActiveDrivers, listAllDrivers } from './goalDriver.js';
import type { DriverState } from './goalDriverTypes.js';

// ── Query pattern detection ──────────────────────────────────────

const STATUS_QUERY_PATTERNS = [
    /\bwhat are you (working on|up to|doing)\b/i,
    /\bhow.{1,10}(going|progressing)\b/i,
    /\bany (blockers?|issues?|problems?)\b/i,
    /\bstatus\??$/i,
    /\bany updates?\b/i,
    /\bare you (stuck|blocked)\b/i,
    /\bwhat'?s (happening|new|up)\b/i,
    /\bgive me (a|an) (update|status|summary)\b/i,
    /\bare goals (done|complete|finished)\b/i,
    /\bshow me the drivers?\b/i,
];

export function isStatusQuery(message: string): boolean {
    return STATUS_QUERY_PATTERNS.some(p => p.test(message));
}

// ── Render ──────────────────────────────────────────────────────

function describePhase(phase: DriverState['phase']): string {
    const labels: Record<DriverState['phase'], string> = {
        planning: '📋 planning',
        delegating: '🚀 delegating',
        observing: '👀 observing',
        iterating: '🔁 iterating (retry)',
        verifying: '✅ verifying',
        reporting: '📝 reporting',
        blocked: '⏸️ BLOCKED on you',
        done: '✓ done',
        failed: '✗ failed',
        cancelled: '⊘ cancelled',
    };
    return labels[phase] || phase;
}

/**
 * System-prompt block for the agent. When included in processMessage's
 * prompt, the agent will report factual driver state instead of guessing.
 */
export function renderDriverStatusBlock(): string | null {
    const drivers = listActiveDrivers();
    if (drivers.length === 0) {
        const all = listAllDrivers();
        const recentDone = all
            .filter(d => d.phase === 'done' && d.retrospective)
            .sort((a, b) => new Date(b.lastTickAt).getTime() - new Date(a.lastTickAt).getTime())
            .slice(0, 5);
        if (recentDone.length === 0) {
            return [
                '━━━━━━━━ ACTIVE DRIVERS ━━━━━━━━',
                'No goal drivers are currently running.',
                'If the user asks what you\'re working on, say so truthfully.',
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            ].join('\n');
        }
        return [
            '━━━━━━━━ ACTIVE DRIVERS ━━━━━━━━',
            'No drivers currently running. Recently completed goals:',
            ...recentDone.map(d => `  • ${d.goalId} (${d.retrospective?.lessonsLearned[0] || 'done'})`),
            'Tell the user truthfully: no active work, these finished recently.',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ].join('\n');
    }

    const lines: string[] = ['━━━━━━━━ ACTIVE DRIVERS ━━━━━━━━'];
    lines.push(`${drivers.length} goal${drivers.length === 1 ? '' : 's'} currently being driven:`);
    for (const d of drivers) {
        const currentSubState = d.currentSubtaskId ? d.subtaskStates[d.currentSubtaskId] : undefined;
        const elapsed = Math.round((Date.now() - new Date(d.startedAt).getTime()) / 1000);
        const parts: string[] = [
            `  • ${d.goalId}: ${describePhase(d.phase)}`,
            `    elapsed=${elapsed}s retries=${d.budget.totalRetries}`,
        ];
        if (currentSubState) {
            parts.push(`    current subtask: kind=${currentSubState.kind}, specialist=${currentSubState.specialist || '?'}, attempts=${currentSubState.attempts}`);
        }
        if (d.phase === 'blocked' && d.blockedReason) {
            parts.push(`    ⚠️ BLOCKED: ${d.blockedReason.question.slice(0, 120)}`);
        }
        lines.push(parts.join('\n'));
    }
    lines.push('');
    lines.push('When answering status questions, use ONLY this data. Do not hallucinate.');
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    return lines.join('\n');
}
