/**
 * Cross-Model Parity Reporter (Phase 6 / v5.3.0)
 *
 * Replays the same tape against multiple provider mocks and produces a
 * structured report of behavioural divergence: tool-name mismatches,
 * argument diffs, finish-reason diffs, content shape diffs.
 *
 * The point isn't to assert byte-equal responses (different models phrase
 * things differently). The point is to assert *behavioural* equivalence —
 * if Anthropic and Ollama see the same prompt, they should both call the
 * same tool with the same arguments, and finish in the same way (stop vs
 * tool_calls). When they don't, the report tells you exactly where they
 * diverge so you can pick a winner or fix the loser.
 *
 * Usage in tests:
 *
 *   import { compareProviderBehavior } from '../../src/eval/parity.js';
 *   const report = await compareProviderBehavior('weather', [
 *     { name: 'ollama',   tape: 'weather' },
 *     { name: 'anthropic', tape: 'weather_anthropic' },
 *   ]);
 *   expect(report.divergences).toEqual([]);
 *
 * Usage at the CLI:
 *
 *   import { formatParityReport } from '../../src/eval/parity.js';
 *   console.log(formatParityReport(report));
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ChatResponse, ChatMessage } from '../providers/base.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAPES_DIR = join(__dirname, '../../tests/fixtures/tapes');

/** A single provider participating in a parity comparison. */
export interface ParityProvider {
    /** Friendly name surfaced in the report (e.g. "ollama", "anthropic"). */
    name: string;
    /** Tape file to replay for this provider. The same logical scenario can
     *  use different tapes per provider when phrasing varies; for the
     *  default "all-providers-from-one-tape" use case, pass the same tape
     *  name to every entry. */
    tape: string;
}

/** A single round's response, normalized for cross-provider comparison. */
export interface NormalizedExchange {
    round: number;
    /** Tool the model decided to call this round, or null if it produced
     *  text instead. */
    tool: string | null;
    /** Tool arguments parsed as a record (`{}` if unparseable). Empty if
     *  no tool call. */
    args: Record<string, unknown>;
    /** Whether the round ended with stop / tool_calls / length / error. */
    finishReason: ChatResponse['finishReason'];
    /** Length of the content payload (we don't compare content text — only
     *  whether content was present at all + how much). */
    contentLength: number;
}

/** A single divergence between providers on a given round. */
export interface ParityDivergence {
    round: number;
    field: 'tool' | 'args' | 'finishReason' | 'content_presence';
    expected: string;
    actual: Array<{ provider: string; value: string }>;
}

/** Output of compareProviderBehavior — the full picture. */
export interface ParityReport {
    /** The provider names compared, in input order. */
    providers: string[];
    /** Per-provider per-round normalized view. The matrix is
     *  `[providerIndex][roundIndex]`. */
    matrix: NormalizedExchange[][];
    /** Diff list — empty array means full parity. */
    divergences: ParityDivergence[];
    /** Number of rounds in the longest tape (others are right-padded). */
    rounds: number;
}

/** Internal — minimal tape shape (response-only fixtures). */
interface Tape {
    name: string;
    exchanges: Array<{ response: ChatResponse }>;
}

function loadTape(name: string): Tape {
    const path = join(TAPES_DIR, `${name}.json`);
    if (!existsSync(path)) {
        throw new Error(`Parity tape not found: ${path}`);
    }
    const tape = JSON.parse(readFileSync(path, 'utf-8')) as Tape;
    if (!Array.isArray(tape.exchanges)) {
        throw new Error(`Malformed tape ${name}: missing exchanges array`);
    }
    return tape;
}

/** Pull the first tool call from a response (we only care about the first
 *  one for parity — multi-tool turns are a separate concern). */
function normalizeRound(round: number, response: ChatResponse): NormalizedExchange {
    const tc = response.toolCalls?.[0];
    let args: Record<string, unknown> = {};
    if (tc?.function?.arguments) {
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
    }
    return {
        round,
        tool: tc?.function?.name ?? null,
        args,
        finishReason: response.finishReason,
        contentLength: (response.content ?? '').length,
    };
}

/** Hash an args object to a deterministic string for comparison.
 *  Sorting keys so {a:1,b:2} == {b:2,a:1}. */
function argsKey(args: Record<string, unknown>): string {
    const sorted = Object.keys(args).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = args[k];
        return acc;
    }, {});
    return JSON.stringify(sorted);
}

/**
 * Replay each provider's tape and compare round-by-round.
 *
 * Note: this function does NOT call any real LLM. It loads the tape
 * fixtures directly. The "providers" here are nominal — we use them as
 * labels in the report. To get real cross-provider data, record fresh
 * tapes against each provider via TITAN_RECORD_TAPE=name and pass those
 * tape names in.
 */
export async function compareProviderBehavior(
    _scenario: string,
    providers: ParityProvider[],
): Promise<ParityReport> {
    if (providers.length < 2) {
        throw new Error('compareProviderBehavior needs at least 2 providers to compare');
    }

    const tapes = providers.map(p => loadTape(p.tape));
    const rounds = Math.max(...tapes.map(t => t.exchanges.length));
    const matrix: NormalizedExchange[][] = tapes.map(t =>
        t.exchanges.map((ex, i) => normalizeRound(i, ex.response)),
    );

    // Use the first provider as the reference. Divergences are reported
    // relative to it.
    const divergences: ParityDivergence[] = [];
    for (let r = 0; r < rounds; r++) {
        const refRound = matrix[0][r];
        if (!refRound) continue; // reference tape ran out — pad below if needed
        for (let p = 1; p < matrix.length; p++) {
            const otherRound = matrix[p][r];
            if (!otherRound) {
                divergences.push({
                    round: r,
                    field: 'tool',
                    expected: `${providers[0].name}: ${refRound.tool ?? '(text)'}`,
                    actual: [{ provider: providers[p].name, value: '(no round)' }],
                });
                continue;
            }
            if (refRound.tool !== otherRound.tool) {
                divergences.push({
                    round: r,
                    field: 'tool',
                    expected: refRound.tool ?? '(text)',
                    actual: [{ provider: providers[p].name, value: otherRound.tool ?? '(text)' }],
                });
            }
            if (refRound.tool && otherRound.tool && refRound.tool === otherRound.tool) {
                if (argsKey(refRound.args) !== argsKey(otherRound.args)) {
                    divergences.push({
                        round: r,
                        field: 'args',
                        expected: JSON.stringify(refRound.args),
                        actual: [{ provider: providers[p].name, value: JSON.stringify(otherRound.args) }],
                    });
                }
            }
            if (refRound.finishReason !== otherRound.finishReason) {
                divergences.push({
                    round: r,
                    field: 'finishReason',
                    expected: refRound.finishReason,
                    actual: [{ provider: providers[p].name, value: otherRound.finishReason }],
                });
            }
            // Content presence: did one provider speak text where another
            // produced a tool call? We don't compare content text — but
            // empty-vs-non-empty is a real behavioural divergence.
            const refHasContent = refRound.contentLength > 0;
            const otherHasContent = otherRound.contentLength > 0;
            if (refHasContent !== otherHasContent) {
                divergences.push({
                    round: r,
                    field: 'content_presence',
                    expected: refHasContent ? 'has-content' : 'empty',
                    actual: [{ provider: providers[p].name, value: otherHasContent ? 'has-content' : 'empty' }],
                });
            }
        }
    }

    return {
        providers: providers.map(p => p.name),
        matrix,
        divergences,
        rounds,
    };
}

/** Fixed-width text rendering of a parity report. Used by the CLI and by
 *  tests when an assertion fails (the assertion error gets the report). */
export function formatParityReport(report: ParityReport): string {
    const lines: string[] = [];
    lines.push(`Cross-model parity: ${report.providers.join(' vs ')}`);
    lines.push(`Rounds compared: ${report.rounds}`);
    lines.push('');

    // Round-by-round matrix
    for (let r = 0; r < report.rounds; r++) {
        lines.push(`── Round ${r + 1} ──`);
        for (let p = 0; p < report.providers.length; p++) {
            const round = report.matrix[p][r];
            if (!round) {
                lines.push(`  ${report.providers[p].padEnd(12)}  (no round)`);
                continue;
            }
            const tool = round.tool ?? '(text reply)';
            const args = Object.keys(round.args).length > 0 ? JSON.stringify(round.args) : '';
            lines.push(`  ${report.providers[p].padEnd(12)}  ${tool}  ${args}  → ${round.finishReason}`);
        }
        lines.push('');
    }

    if (report.divergences.length === 0) {
        lines.push('✓ Full behavioural parity — 0 divergences');
    } else {
        lines.push(`✗ ${report.divergences.length} divergence(s):`);
        for (const d of report.divergences) {
            lines.push(`  Round ${d.round + 1} · ${d.field}: expected ${d.expected}`);
            for (const a of d.actual) {
                lines.push(`    ${a.provider}: ${a.value}`);
            }
        }
    }
    return lines.join('\n');
}
