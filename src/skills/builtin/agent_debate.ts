/**
 * TITAN — Agent Debate (F3)
 *
 * When two or more agents should weigh in on a contested question, run a
 * structured multi-round debate and resolve the disagreement via vote,
 * synthesis, or judge. Each round shows every participant the others'
 * latest positions; guardrails strip chain-of-thought leakage from each
 * turn. Full transcripts are persisted to ~/.titan/debates/.
 *
 * Unlike mixture_of_agents (one-shot, parallel, independent), debate is
 * iterative — agents see each other's arguments and update their positions.
 *
 * Composes existing primitives:
 *   - router.chat()            — per-turn LLM calls
 *   - outputGuardrails         — strip CoT from every turn
 *   - mixture_of_agents.vote() — word-overlap consensus for 'vote' mode
 *   - commandPost.addActivity  — observable via Mission Control
 */
import { existsSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { v4 as uuid } from 'uuid';
import { registerSkill } from '../registry.js';
import { chat } from '../../providers/router.js';
import { loadConfig } from '../../config/config.js';
import { applyOutputGuardrails } from '../../agent/outputGuardrails.js';
import { TITAN_HOME } from '../../utils/constants.js';
import { mkdirIfNotExists } from '../../utils/helpers.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'AgentDebate';
const DEBATES_DIR = join(TITAN_HOME, 'debates');
const MAX_ROUNDS = 4;
const MAX_PARTICIPANTS = 5;
const MIN_PARTICIPANTS = 2;

// ── Types ────────────────────────────────────────────────────────

export interface DebateParticipant {
    /** Short role label that frames the agent's vantage. */
    role: string;
    /** Full provider/model id. Falls back to config.agent.model. */
    model?: string;
    /** Optional pre-seeded position. If omitted, the agent forms one in round 1. */
    position?: string;
}

export type DebateResolution = 'vote' | 'synthesize' | 'judge';

export interface DebateTurn {
    round: number;
    role: string;
    model: string;
    content: string;
    rawLength: number;
    guardrailScore: number;
    durationMs: number;
}

export interface DebateTranscript {
    id: string;
    question: string;
    participants: DebateParticipant[];
    rounds: number;
    resolution: DebateResolution;
    turns: DebateTurn[];
    winner?: { role: string; content: string; justification?: string };
    startedAt: string;
    completedAt: string;
    durationMs: number;
}

// ── Vote (copied from mixture_of_agents so we don't introduce a module dep) ─

function voteByConsensus(entries: Array<{ role: string; content: string }>): { role: string; content: string } {
    if (entries.length === 1) return entries[0];
    const words = entries.map(e => new Set(e.content.toLowerCase().split(/\s+/).filter(w => w.length > 3)));
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < entries.length; i++) {
        let score = 0;
        for (let j = 0; j < entries.length; j++) {
            if (i === j) continue;
            for (const word of words[i]) {
                if (words[j].has(word)) score++;
            }
        }
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }
    return entries[bestIdx];
}

// ── Prompt builders ──────────────────────────────────────────────

function buildOpeningPrompt(question: string, role: string, seeded?: string): string {
    if (seeded) {
        return `You are participating in a debate as "${role}". Your pre-assigned position is below — defend and sharpen it. Do NOT abandon it in the opening turn.

## Question
${question}

## Your assigned position
${seeded}

## Your task
Open the debate by stating your position and the single strongest argument for it. 3-6 sentences. Direct, no preamble. No hedging like "I think" or "in my opinion".`;
    }
    return `You are participating in a debate as "${role}". Form a clear, distinctive position on the question and defend it.

## Question
${question}

## Your task
Open the debate by stating your position and the single strongest argument for it. 3-6 sentences. Direct, no preamble. No hedging.`;
}

function buildRebuttalPrompt(
    question: string,
    role: string,
    myLastPosition: string,
    othersLatest: Array<{ role: string; content: string }>,
    round: number,
    totalRounds: number,
): string {
    const peers = othersLatest.map(o => `### ${o.role}\n${o.content}`).join('\n\n');
    const finalRound = round === totalRounds;
    return `You are participating in a debate as "${role}". This is round ${round} of ${totalRounds}.

## Question
${question}

## Your previous position
${myLastPosition}

## Other participants' latest arguments
${peers}

## Your task
${finalRound
        ? 'This is the FINAL round. State your concluding position — account for the strongest counterarguments, concede anything you were wrong about, and commit to your answer. 4-8 sentences.'
        : 'Engage directly with the strongest counterargument you see. You may concede, refine, or stand firm — but be specific about which peer\'s point you\'re addressing. 4-7 sentences.'}
No preamble. Do not write "<think>" blocks or narrate your reasoning process.`;
}

/** JSON schema for Ollama's native structured outputs — constrains the judge
 *  verdict to the exact shape parseJudgeVerdict() expects. */
const JUDGE_VERDICT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    required: ['winnerRole', 'justification', 'finalAnswer'],
    properties: {
        winnerRole: { type: 'string' },
        justification: { type: 'string' },
        finalAnswer: { type: 'string' },
    },
};

function buildJudgePrompt(question: string, transcript: DebateTurn[]): string {
    const rounds = new Map<number, DebateTurn[]>();
    for (const t of transcript) {
        const arr = rounds.get(t.round) || [];
        arr.push(t);
        rounds.set(t.round, arr);
    }
    const formatted: string[] = [];
    for (const [r, turns] of [...rounds.entries()].sort((a, b) => a[0] - b[0])) {
        formatted.push(`## Round ${r}`);
        for (const t of turns) formatted.push(`### ${t.role}\n${t.content}`);
    }

    return `You are an impartial judge reviewing a structured debate. Read every round in full, then pick the single most defensible position.

## Question
${question}

${formatted.join('\n\n')}

## Your task
Return ONLY a JSON object:
{
  "winnerRole": "<role name exactly as above>",
  "justification": "<2-3 sentences explaining the decision>",
  "finalAnswer": "<a polished version of the winning position — not a quote, a synthesis of the winner's argument as a direct answer to the question>"
}
No prose outside the JSON. No code fences.`;
}

function buildSynthesisPrompt(question: string, finalPositions: Array<{ role: string; content: string }>): string {
    const formatted = finalPositions.map(p => `### ${p.role}\n${p.content}`).join('\n\n');
    return `You are a synthesizer. Multiple debaters argued positions on the question below. Combine the strongest reasoning from each into a single coherent answer.

## Question
${question}

## Final Positions
${formatted}

## Your task
Write the single best answer. 4-8 sentences. Do NOT mention the debate, rounds, or that multiple positions existed. Just answer the question, leveraging the strongest points you read.`;
}

// ── Core orchestration ──────────────────────────────────────────

interface RunOptions {
    question: string;
    participants: DebateParticipant[];
    rounds: number;
    resolution: DebateResolution;
    judgeModel?: string;
}

async function callParticipant(model: string, prompt: string, role: string, round: number): Promise<DebateTurn> {
    const started = Date.now();
    let rawContent = '';
    try {
        const response = await chat({
            model,
            messages: [
                { role: 'system', content: 'You are a debate participant. Respond in direct prose only. No <think> tags, no tool JSON, no markdown headers in the reply.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.7,
            maxTokens: 800,
        });
        rawContent = response.content || '';
    } catch (err) {
        logger.warn(COMPONENT, `${role} (model ${model}) failed in round ${round}: ${(err as Error).message}`);
        return {
            round, role, model,
            content: `[${role} failed to respond: ${(err as Error).message}]`,
            rawLength: 0, guardrailScore: 0,
            durationMs: Date.now() - started,
        };
    }

    const guard = applyOutputGuardrails(rawContent, { type: 'sub_agent' });
    return {
        round, role, model,
        content: guard.content || rawContent,
        rawLength: rawContent.length,
        guardrailScore: guard.score,
        durationMs: Date.now() - started,
    };
}

async function runDebate(opts: RunOptions): Promise<DebateTranscript> {
    const config = loadConfig();
    const defaultModel = config.agent.model;
    const debateId = `dbt-${Date.now().toString(36)}-${uuid().slice(0, 4)}`;
    const startedAt = new Date().toISOString();
    const start = Date.now();

    // Normalize participants — resolve model, ensure unique roles.
    const seenRoles = new Set<string>();
    const participants: DebateParticipant[] = [];
    for (const p of opts.participants) {
        let role = p.role.trim();
        if (!role) role = `participant-${participants.length + 1}`;
        let unique = role;
        let n = 2;
        while (seenRoles.has(unique)) unique = `${role}-${n++}`;
        seenRoles.add(unique);
        participants.push({ role: unique, model: p.model || defaultModel, position: p.position });
    }

    const transcript: DebateTranscript = {
        id: debateId,
        question: opts.question,
        participants,
        rounds: opts.rounds,
        resolution: opts.resolution,
        turns: [],
        startedAt,
        completedAt: startedAt,
        durationMs: 0,
    };

    // Phase 1: opening positions in parallel.
    logger.info(COMPONENT, `Debate ${debateId} opening: ${participants.length} participants, ${opts.rounds} rounds`);
    const openingPromises = participants.map(p =>
        callParticipant(p.model!, buildOpeningPrompt(opts.question, p.role, p.position), p.role, 1),
    );
    const openings = await Promise.all(openingPromises);
    transcript.turns.push(...openings);

    // Phase 2: rebuttal rounds (2..N). Each round, every participant sees the
    // others' LATEST turn. Participants step sequentially within a round so each
    // gets the same snapshot of peers, but rounds are sequential.
    const latestByRole = new Map<string, string>();
    for (const t of openings) latestByRole.set(t.role, t.content);

    for (let r = 2; r <= opts.rounds; r++) {
        const snapshot = new Map(latestByRole);
        const roundPromises = participants.map(p => {
            const my = snapshot.get(p.role) || '';
            const others = participants
                .filter(x => x.role !== p.role)
                .map(x => ({ role: x.role, content: snapshot.get(x.role) || '' }));
            return callParticipant(
                p.model!,
                buildRebuttalPrompt(opts.question, p.role, my, others, r, opts.rounds),
                p.role,
                r,
            );
        });
        const roundTurns = await Promise.all(roundPromises);
        transcript.turns.push(...roundTurns);
        for (const t of roundTurns) latestByRole.set(t.role, t.content);
    }

    // Phase 3: resolve.
    const finalPositions = participants.map(p => ({ role: p.role, content: latestByRole.get(p.role) || '' }));
    if (opts.resolution === 'vote') {
        const winner = voteByConsensus(finalPositions);
        transcript.winner = { role: winner.role, content: winner.content, justification: 'highest word-overlap consensus with peers' };
    } else if (opts.resolution === 'synthesize') {
        const synthModel = opts.judgeModel || (config.agent.modelAliases['smart'] || defaultModel);
        try {
            const synth = await chat({
                model: synthModel,
                messages: [
                    { role: 'system', content: 'You synthesize debate outcomes into single direct answers.' },
                    { role: 'user', content: buildSynthesisPrompt(opts.question, finalPositions) },
                ],
                temperature: 0.4,
                maxTokens: 600,
            });
            const guarded = applyOutputGuardrails(synth.content, { type: 'sub_agent' });
            transcript.winner = { role: 'synthesis', content: guarded.content, justification: 'combined strongest reasoning across final positions' };
        } catch (err) {
            logger.warn(COMPONENT, `Synthesis fell back to vote: ${(err as Error).message}`);
            const fallback = voteByConsensus(finalPositions);
            transcript.winner = { role: fallback.role, content: fallback.content, justification: 'synthesis failed — fell back to consensus vote' };
        }
    } else {
        // judge
        const judgeModel = opts.judgeModel || (config.agent.modelAliases['smart'] || defaultModel);
        // Only Ollama honours the `format` JSON-schema constraint today.
        // For everything else we keep the belt-and-suspenders prompt + regex
        // parse path (see parseJudgeVerdict + fallback-to-vote below).
        const isOllamaJudge = judgeModel.toLowerCase().startsWith('ollama/');
        try {
            const verdict = await chat({
                model: judgeModel,
                messages: [
                    { role: 'system', content: 'You are an impartial debate judge. Output ONLY JSON.' },
                    { role: 'user', content: buildJudgePrompt(opts.question, transcript.turns) },
                ],
                temperature: 0.2,
                maxTokens: 600,
                ...(isOllamaJudge ? { format: JUDGE_VERDICT_SCHEMA } : {}),
            });
            const guarded = applyOutputGuardrails(verdict.content, { type: 'sub_agent' });
            const parsed = parseJudgeVerdict(guarded.content);
            if (parsed) {
                transcript.winner = {
                    role: parsed.winnerRole,
                    content: parsed.finalAnswer,
                    justification: parsed.justification,
                };
            } else {
                logger.warn(COMPONENT, `Judge verdict malformed — falling back to vote`);
                const fallback = voteByConsensus(finalPositions);
                transcript.winner = { role: fallback.role, content: fallback.content, justification: 'judge verdict malformed — fell back to consensus vote' };
            }
        } catch (err) {
            logger.warn(COMPONENT, `Judge failed, falling back to vote: ${(err as Error).message}`);
            const fallback = voteByConsensus(finalPositions);
            transcript.winner = { role: fallback.role, content: fallback.content, justification: 'judge unavailable — fell back to consensus vote' };
        }
    }

    transcript.completedAt = new Date().toISOString();
    transcript.durationMs = Date.now() - start;
    persistTranscript(transcript);
    emitActivity(transcript);

    return transcript;
}

function parseJudgeVerdict(raw: string): { winnerRole: string; justification: string; finalAnswer: string } | null {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const matchers = [trimmed, trimmed.match(/\{[\s\S]*\}/)?.[0] || ''];
    for (const candidate of matchers) {
        if (!candidate) continue;
        try {
            const parsed = JSON.parse(candidate);
            if (
                typeof parsed.winnerRole === 'string' &&
                typeof parsed.justification === 'string' &&
                typeof parsed.finalAnswer === 'string'
            ) {
                return parsed;
            }
        } catch { /* next */ }
    }
    return null;
}

function persistTranscript(t: DebateTranscript): void {
    try {
        mkdirIfNotExists(DEBATES_DIR);
        writeFileSync(join(DEBATES_DIR, `${t.id}.json`), JSON.stringify(t, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(COMPONENT, `Failed to persist transcript ${t.id}: ${(err as Error).message}`);
    }
}

function emitActivity(t: DebateTranscript): void {
    // Fire on titanEvents directly. Command Post's activity-feed subscriber
    // (if enabled) picks up 'commandpost:activity' and persists to the JSONL
    // feed + buffer. Keeping this as a titanEvents.emit avoids a hard dep
    // on commandPost module (which isn't always initialized during tests).
    (async () => {
        try {
            const { titanEvents } = await import('../../agent/daemon.js');
            titanEvents.emit('commandpost:activity', {
                id: t.id,
                timestamp: t.completedAt,
                type: 'debate_resolved',
                message: `Debate "${t.question.slice(0, 80)}" resolved via ${t.resolution} — winner: ${t.winner?.role ?? 'unknown'}`,
                metadata: {
                    debateId: t.id,
                    participants: t.participants.map(p => p.role),
                    resolution: t.resolution,
                    rounds: t.rounds,
                    durationMs: t.durationMs,
                },
            });
        } catch { /* non-critical */ }
    })().catch(() => { /* non-critical */ });
}

// ── Read-side helpers (for API) ──────────────────────────────────

export function listDebates(limit = 50): Array<Pick<DebateTranscript, 'id' | 'question' | 'resolution' | 'rounds' | 'startedAt' | 'completedAt' | 'durationMs'> & { winnerRole?: string }> {
    try {
        if (!existsSync(DEBATES_DIR)) return [];
        const files = readdirSync(DEBATES_DIR).filter(f => f.endsWith('.json'));
        const entries = files.map(f => {
            try {
                const raw = readFileSync(join(DEBATES_DIR, f), 'utf-8');
                const t = JSON.parse(raw) as DebateTranscript;
                return {
                    id: t.id, question: t.question, resolution: t.resolution,
                    rounds: t.rounds, startedAt: t.startedAt, completedAt: t.completedAt,
                    durationMs: t.durationMs, winnerRole: t.winner?.role,
                };
            } catch { return null; }
        }).filter((x): x is NonNullable<typeof x> => x !== null);
        entries.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
        return entries.slice(0, limit);
    } catch { return []; }
}

export function getDebate(id: string): DebateTranscript | null {
    try {
        const p = join(DEBATES_DIR, `${id}.json`);
        if (!existsSync(p)) return null;
        return JSON.parse(readFileSync(p, 'utf-8')) as DebateTranscript;
    } catch { return null; }
}

// ── Skill Registration ──────────────────────────────────────────

export function registerAgentDebateSkill(): void {
    registerSkill(
        {
            name: 'agent_debate',
            description: 'Run a structured multi-round debate between N agents and resolve disagreements',
            version: '1.0.0',
            source: 'bundled',
            enabled: true,
        },
        {
            name: 'agent_debate',
            description: 'Run a structured debate between 2-5 agents on a contested question. Each round, every participant sees the others\' latest arguments and refines their position. Resolution via consensus vote, LLM synthesis, or impartial judge.\nUSE THIS WHEN: user explicitly requests a "debate", asks two agents to "argue about" / "disagree on" something, or needs multiple perspectives weighed against each other (not merged). Prefer mixture_of_agents for parallel independent opinions.',
            parameters: {
                type: 'object',
                properties: {
                    question: { type: 'string', description: 'The contested question. A yes/no or short-answer question works best.' },
                    participants: {
                        type: 'array',
                        description: `${MIN_PARTICIPANTS}-${MAX_PARTICIPANTS} agents. Each has a role label and optionally a model override + pre-seeded position.`,
                        items: {
                            type: 'object',
                            properties: {
                                role: { type: 'string', description: 'Role/vantage (e.g. "pragmatist", "skeptic", "security lead")' },
                                model: { type: 'string', description: 'provider/model id. Defaults to config.agent.model.' },
                                position: { type: 'string', description: 'Optional pre-seeded opening position.' },
                            },
                            required: ['role'],
                        },
                    },
                    rounds: { type: 'number', description: `Number of rebuttal rounds (1-${MAX_ROUNDS}). Default 2.`, minimum: 1, maximum: MAX_ROUNDS },
                    resolution: { type: 'string', enum: ['vote', 'synthesize', 'judge'], description: 'How to pick a winner. Default "judge".' },
                    judgeModel: { type: 'string', description: 'Model for the judge/synthesizer. Default uses the "smart" alias.' },
                },
                required: ['question', 'participants'],
            },
            execute: async (args) => {
                const question = (args.question as string || '').trim();
                if (!question) return 'Error: question is required.';
                const rawParticipants = (args.participants as DebateParticipant[] | undefined) || [];
                if (rawParticipants.length < MIN_PARTICIPANTS || rawParticipants.length > MAX_PARTICIPANTS) {
                    return `Error: need ${MIN_PARTICIPANTS}-${MAX_PARTICIPANTS} participants, got ${rawParticipants.length}.`;
                }
                const rounds = Math.max(1, Math.min(MAX_ROUNDS, (args.rounds as number) ?? 2));
                const resolution = (args.resolution as DebateResolution) || 'judge';
                const judgeModel = args.judgeModel as string | undefined;

                const result = await runDebate({ question, participants: rawParticipants, rounds, resolution, judgeModel });
                const winnerBlock = result.winner
                    ? `\n\n## Winner: ${result.winner.role}\n${result.winner.content}${result.winner.justification ? `\n\n_${result.winner.justification}_` : ''}`
                    : '\n\n(No winner determined.)';
                return `Debate ${result.id} complete. ${result.participants.length} participants, ${result.rounds} rounds, resolved via ${result.resolution} in ${result.durationMs}ms.${winnerBlock}\n\nFull transcript: GET /api/command-post/debates/${result.id}`;
            },
        },
    );
}

// Export the runner for tests + server usage.
export { runDebate };
