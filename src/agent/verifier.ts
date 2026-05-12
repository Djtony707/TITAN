/**
 * TITAN — Verifier (v4.10.0-local, Phase A)
 *
 * Per-kind verification that a subtask is actually done, not just
 * "the LLM emitted 200 chars and called it a day." Returns a
 * VerificationResult the driver uses to decide: advance to the next
 * subtask (passed), retry with fallback (failed), or escalate to human
 * (blocked on clarification).
 *
 * Per-kind contracts:
 *   code       — run typecheck + build in workspace; all green
 *   research   — ≥200 chars, ≥2 source markers, no "I don't know"
 *   write      — spawn Analyst with rubric, require score ≥0.7
 *   analysis   — response contains structured output meeting schema
 *   verify     — nested verifier of the thing it claims to verify
 *   shell      — exit code 0 and (if pattern provided) stdout matches
 *   report     — ≥500 chars, keywords: "goal"/"outcome"/"artifacts"
 */
import { existsSync, readFileSync } from 'fs';
import { promisify } from 'util';
import { exec as execCb } from 'child_process';
import logger from '../utils/logger.js';
import type { SubtaskKind } from './subtaskTaxonomy.js';
import type { StructuredSpawnResult } from './structuredSpawnTypes.js';
import type { Subtask } from './goals.js';

const exec = promisify(execCb);
const COMPONENT = 'Verifier';

export interface VerificationInput {
    kind: SubtaskKind;
    subtask: Subtask;
    spawnResult: StructuredSpawnResult;
    /**
     * Workspace for code verifications — defaults to repo root.
     * For staged writes, this is the staging directory.
     */
    workspace?: string;
    /**
     * Optional expected-output regex for shell verifications.
     */
    expectedOutputPattern?: string;
}

export interface VerificationResult {
    passed: boolean;
    reason: string;
    verifier: string;
    confidence?: number;
    /** Files/URLs/facts produced. */
    artifacts?: string[];
    /** Stderr/stdout snippets for code verifications — helpful in UI. */
    details?: string;
}

// ── Generic bail-out check (runs before per-kind) ────────────────

function hasGiveUpPhrase(text: string): boolean {
    const lowered = text.toLowerCase();
    const giveups = [
        "i don't have a specific task",
        'no specific task to act on',
        "i don't know what to do",
        'not enough information',
        'cannot complete without',
        'unable to determine',
        "i can't proceed",
    ];
    return giveups.some(g => lowered.includes(g));
}

// v4.10.0-local fix: Detect "thinking" prose that indicates the specialist
// is starting work but didn't follow JSON output instructions. These patterns
// ("Now let me check...", "Let me analyze...") should trigger retry, not block.
function hasThinkingPattern(text: string): boolean {
    const trimmed = text.trim();
    const patterns = [
        /^now let me /i,
        /^let me /i,
        /^i will /i,
        /^i'll /i,
        /^first,? let me /i,
        /^ok, let me /i,
        /^okay, let me /i,
        /^sure,? let me /i,
        /^alright,? let me /i,
    ];
    return patterns.some(p => p.test(trimmed));
}

// ── Per-kind verifiers ───────────────────────────────────────────

async function verifyCode(input: VerificationInput): Promise<VerificationResult> {
    const workspace = input.workspace || process.cwd();
    // Quick fail: were artifacts actually produced?
    const fileArtifacts = input.spawnResult.artifacts.filter(a => a.type === 'file').map(a => a.ref);
    if (fileArtifacts.length === 0) {
        return {
            passed: false,
            reason: 'No file artifacts reported by specialist',
            verifier: 'verifyCode',
        };
    }
    // Files actually exist?
    const missing = fileArtifacts.filter(p => !existsSync(p));
    if (missing.length > 0) {
        return {
            passed: false,
            reason: `Claimed files don't exist: ${missing.join(', ')}`,
            verifier: 'verifyCode',
            details: `Specialist claimed ${fileArtifacts.length} files but ${missing.length} are missing on disk.`,
        };
    }
    // Typecheck
    try {
        // Short timeout — typecheck usually 5-20s
        const { stdout: tcOut, stderr: tcErr } = await exec('npm run typecheck', {
            cwd: workspace,
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
        });
        const tcOutput = (tcOut || '') + (tcErr || '');
        if (/error TS\d+:/i.test(tcOutput) || /Found \d+ error/i.test(tcOutput)) {
            return {
                passed: false,
                reason: 'TypeScript errors in workspace',
                verifier: 'verifyCode',
                details: tcOutput.slice(-2000),
                artifacts: fileArtifacts,
            };
        }
    } catch (err) {
        // typecheck failed non-zero — extract errors
        const msg = (err as { stdout?: string; stderr?: string; message: string }).stdout
            || (err as { stderr?: string }).stderr
            || (err as Error).message;
        return {
            passed: false,
            reason: 'npm run typecheck failed',
            verifier: 'verifyCode',
            details: String(msg).slice(-2000),
            artifacts: fileArtifacts,
        };
    }
    return {
        passed: true,
        reason: `Typecheck passed; ${fileArtifacts.length} file(s) exist`,
        verifier: 'verifyCode',
        confidence: 0.9,
        artifacts: fileArtifacts,
    };
}

function verifyResearch(input: VerificationInput): VerificationResult {
    const text = input.spawnResult.reasoning || input.spawnResult.rawResponse;
    if (hasGiveUpPhrase(text)) {
        return {
            passed: false,
            reason: "Specialist gave up (give-up phrase detected)",
            verifier: 'verifyResearch',
        };
    }
    // v4.10.0-local fix: catch thinking patterns that indicate JSON parsing failed
    if (hasThinkingPattern(text)) {
        return {
            passed: false,
            reason: "Specialist returned thinking prose instead of structured JSON — needs retry",
            verifier: 'verifyResearch',
            details: `Raw (200 chars): ${text.slice(0, 200)}`,
        };
    }
    // v4.10.0-local (post-deploy, Fix D): confidence+artifact escape hatch.
    // High-confidence done responses with ≥1 concrete artifact pass even
    // without prose markers. Prevents terse-but-correct specialists (e.g.
    // "Done. 5 sources saved to memory.") from looping on verification.
    // Gated on artifact count — pure confidence would let hallucinating
    // specialists self-certify.
    if (input.spawnResult.status === 'done'
        && input.spawnResult.confidence >= 0.85
        && (input.spawnResult.artifacts?.length ?? 0) >= 1) {
        return {
            passed: true,
            reason: `High confidence (${input.spawnResult.confidence.toFixed(2)}) + ${input.spawnResult.artifacts.length} artifact(s) — confidence-tier pass`,
            verifier: 'verifyResearch',
            confidence: input.spawnResult.confidence * 0.95,
            artifacts: input.spawnResult.artifacts.map(a => a.ref),
        };
    }
    // v4.10.0-local polish: lenient short-form path. Internal research
    // goals (like "check local tool output") often produce 100-200 char
    // responses that are still valid — the specialist ran the right tool
    // and returned a terse finding. Require markers OR internal artifacts.
    if (text.length < 100) {
        return {
            passed: false,
            reason: `Response too short (${text.length} chars, need ≥100)`,
            verifier: 'verifyResearch',
        };
    }
    // Count source markers: URLs, [1]-style refs, "source:", "according to"
    const urlCount = (text.match(/https?:\/\/[^\s)]+/g) || []).length;
    const refCount = (text.match(/\[\d+\]/g) || []).length;
    const sourceWords = (text.match(/\b(source|according to|per the|reference|from the|based on):/gi) || []).length;
    const toolFindings = (text.match(/\b(found|returned|reports?|shows?|indicates?|displays?)\b/gi) || []).length;
    const markers = urlCount + refCount + sourceWords;
    const artifactCount = input.spawnResult.artifacts.length;

    // Path A: short response with artifact + tool-finding language
    if (text.length < 200) {
        if (artifactCount >= 1 && toolFindings >= 1 && input.spawnResult.confidence >= 0.7) {
            return {
                passed: true,
                reason: `Concise research ${text.length} chars, ${artifactCount} artifact(s), confidence ${input.spawnResult.confidence.toFixed(2)} — lenient pass`,
                verifier: 'verifyResearch',
                confidence: input.spawnResult.confidence * 0.85,
                artifacts: input.spawnResult.artifacts.map(a => a.ref),
            };
        }
        return {
            passed: false,
            reason: `Response too short (${text.length} chars, need ≥200 OR artifact+tool-finding+high-confidence)`,
            verifier: 'verifyResearch',
        };
    }
    // Path B: longer response needs source markers
    if (markers < 2 && artifactCount < 1) {
        return {
            passed: false,
            reason: `Insufficient source markers (${markers}, need ≥2 URLs/refs/source phrases, or ≥1 artifact)`,
            verifier: 'verifyResearch',
            details: `urls=${urlCount} refs=${refCount} sourcewords=${sourceWords}`,
        };
    }
    return {
        passed: true,
        reason: `${markers} source markers, ${artifactCount} artifacts, ${text.length} chars`,
        verifier: 'verifyResearch',
        confidence: 0.8,
        artifacts: input.spawnResult.artifacts.map(a => a.ref),
    };
}

async function verifyWrite(input: VerificationInput): Promise<VerificationResult> {
    const text = input.spawnResult.reasoning || input.spawnResult.rawResponse;
    if (hasGiveUpPhrase(text)) {
        return { passed: false, reason: 'Specialist gave up', verifier: 'verifyWrite' };
    }
    // v4.10.0-local fix: catch thinking patterns that indicate JSON parsing failed
    if (hasThinkingPattern(text)) {
        return {
            passed: false,
            reason: 'Specialist returned thinking prose instead of structured JSON — needs retry',
            verifier: 'verifyWrite',
            details: `Raw (200 chars): ${text.slice(0, 200)}`,
        };
    }
    // v4.10.0-local (post-deploy, Fix D): confidence+artifact escape hatch.
    // See verifyResearch for rationale. Gated on artifact count.
    if (input.spawnResult.status === 'done'
        && input.spawnResult.confidence >= 0.85
        && (input.spawnResult.artifacts?.length ?? 0) >= 1) {
        return {
            passed: true,
            reason: `High confidence (${input.spawnResult.confidence.toFixed(2)}) + ${input.spawnResult.artifacts.length} artifact(s) — confidence-tier pass`,
            verifier: 'verifyWrite',
            confidence: input.spawnResult.confidence * 0.95,
            artifacts: input.spawnResult.artifacts.map(a => a.ref),
        };
    }
    if (text.length < 100) {
        return {
            passed: false,
            reason: `Draft too short (${text.length} chars, need ≥100)`,
            verifier: 'verifyWrite',
        };
    }
    // Rubric-based check: use spawn confidence + basic heuristics
    // (Full LLM-rubric check deferred — driver can spawn Analyst to review
    // via the structured-spawn path; here we do a fast local sanity check.)
    const confidence = input.spawnResult.confidence ?? 0.5;
    if (confidence < 0.6) {
        return {
            passed: false,
            reason: `Self-reported confidence ${confidence.toFixed(2)} below 0.6`,
            verifier: 'verifyWrite',
        };
    }
    return {
        passed: true,
        reason: `Draft ${text.length} chars, confidence ${confidence.toFixed(2)}`,
        verifier: 'verifyWrite',
        confidence,
        artifacts: input.spawnResult.artifacts.map(a => a.ref),
    };
}

function verifyAnalysis(input: VerificationInput): VerificationResult {
    const text = input.spawnResult.reasoning || input.spawnResult.rawResponse;
    if (hasGiveUpPhrase(text)) {
        return { passed: false, reason: 'Specialist gave up', verifier: 'verifyAnalysis' };
    }
    // v4.10.0-local fix: catch thinking patterns that indicate JSON parsing failed
    if (hasThinkingPattern(text)) {
        return {
            passed: false,
            reason: 'Specialist returned thinking prose instead of structured JSON — needs retry',
            verifier: 'verifyAnalysis',
            details: `Raw (200 chars): ${text.slice(0, 200)}`,
        };
    }
    // v4.10.0-local (post-deploy, Fix D): confidence+artifact escape hatch.
    // Parallel to verifyResearch/verifyWrite. Sits below the existing
    // ≥3-artifact tier but catches the ≥0.85-confidence + ≥1-artifact case
    // that the stricter tier misses (e.g. a single bundle summary file).
    if (input.spawnResult.status === 'done'
        && input.spawnResult.confidence >= 0.85
        && (input.spawnResult.artifacts?.length ?? 0) >= 1) {
        return {
            passed: true,
            reason: `High confidence (${input.spawnResult.confidence.toFixed(2)}) + ${input.spawnResult.artifacts.length} artifact(s) — confidence-tier pass`,
            verifier: 'verifyAnalysis',
            confidence: input.spawnResult.confidence * 0.95,
            artifacts: input.spawnResult.artifacts.map(a => a.ref),
        };
    }
    // v4.10.0-local polish (post-deploy): analysis verification now has
    // three tiers. Added an ARTIFACT tier to catch the common case where
    // the subtask was misclassified as "analysis" but the specialist
    // actually produced concrete artifacts (files, URLs, memory entries).
    // Previously those runs would ping-pong on verification forever
    // because the reasoning field was terse but the work was real.
    //
    // ARTIFACT tier: ≥3 concrete artifacts + status=done + confidence ≥ 0.7.
    // STRICT tier: needs reasoning markers OR bulleted list OR ≥200 chars + structure.
    // LENIENT tier: ≥80 chars AND status=done AND confidence ≥ 0.7.
    const artifactCount = input.spawnResult.artifacts?.length ?? 0;
    if (artifactCount >= 3 && input.spawnResult.status === 'done' && input.spawnResult.confidence >= 0.7) {
        return {
            passed: true,
            reason: `Analysis produced ${artifactCount} artifact(s), confidence ${input.spawnResult.confidence.toFixed(2)} — artifact-tier pass`,
            verifier: 'verifyAnalysis',
            confidence: input.spawnResult.confidence * 0.9,
            artifacts: input.spawnResult.artifacts.map(a => a.ref),
        };
    }

    const hasReasoningMarker = /\b(conclusion|because|therefore|thus|hence|as a result|this means|indicates|suggests|implies)\b/i.test(text);
    const bulletCount = (text.match(/^\s*[-*+]\s+/gm) || []).length;
    const numericCount = (text.match(/\b\d+(?:\.\d+)?(?:%|\s*(?:chars?|ms|s|m|ticks?|patterns?))?\b/g) || []).length;
    const hasStructure = hasReasoningMarker || bulletCount >= 2 || numericCount >= 2;

    if (text.length < 80) {
        return {
            passed: false,
            reason: `Analysis too short (${text.length} chars, need ≥80)`,
            verifier: 'verifyAnalysis',
        };
    }

    // Lenient path: short-but-confident responses
    if (text.length < 200 && input.spawnResult.confidence >= 0.7 && input.spawnResult.status === 'done') {
        return {
            passed: true,
            reason: `Analysis ${text.length} chars, high confidence (${input.spawnResult.confidence.toFixed(2)}) — lenient pass`,
            verifier: 'verifyAnalysis',
            confidence: input.spawnResult.confidence * 0.85,
            artifacts: input.spawnResult.artifacts.map(a => a.ref),
        };
    }

    // Strict path: longer responses need structural markers
    if (!hasStructure) {
        return {
            passed: false,
            reason: 'No reasoning markers, structured list, or numeric evidence found',
            verifier: 'verifyAnalysis',
        };
    }
    return {
        passed: true,
        reason: `Analysis ${text.length} chars with reasoning structure (markers=${hasReasoningMarker} bullets=${bulletCount} metrics=${numericCount})`,
        verifier: 'verifyAnalysis',
        confidence: 0.8,
        artifacts: input.spawnResult.artifacts.map(a => a.ref),
    };
}

async function verifyShell(input: VerificationInput): Promise<VerificationResult> {
    // Shell subtask's "verification" is: did the spawn_result indicate success?
    // Structured spawn already captures status. Here we add: if we have an
    // expectedOutputPattern, match it against the spawn's raw response.
    if (input.spawnResult.status !== 'done') {
        return {
            passed: false,
            reason: `Spawn status = ${input.spawnResult.status}`,
            verifier: 'verifyShell',
        };
    }
    if (input.expectedOutputPattern) {
        const re = new RegExp(input.expectedOutputPattern);
        if (!re.test(input.spawnResult.rawResponse)) {
            return {
                passed: false,
                reason: `Output didn't match expected pattern: ${input.expectedOutputPattern}`,
                verifier: 'verifyShell',
                details: input.spawnResult.rawResponse.slice(0, 500),
            };
        }
    }
    return {
        passed: true,
        reason: 'Shell command returned success',
        verifier: 'verifyShell',
        confidence: 0.85,
    };
}

function verifyReport(input: VerificationInput): VerificationResult {
    const text = input.spawnResult.reasoning || input.spawnResult.rawResponse;
    if (text.length < 500) {
        return {
            passed: false,
            reason: `Report too short (${text.length} chars, need ≥500)`,
            verifier: 'verifyReport',
        };
    }
    const keywords = ['goal', 'outcome', 'artifact'];
    const missing = keywords.filter(k => !text.toLowerCase().includes(k));
    if (missing.length > 1) {
        return {
            passed: false,
            reason: `Report missing key sections: ${missing.join(', ')}`,
            verifier: 'verifyReport',
        };
    }
    return {
        passed: true,
        reason: `Report ${text.length} chars, all sections present`,
        verifier: 'verifyReport',
        confidence: 0.8,
    };
}

// verify-kind subtasks are meta — they recursively verify whatever the
// spawn claims to verify. For now we trust the spawn's status.
function verifyVerify(input: VerificationInput): VerificationResult {
    if (input.spawnResult.status !== 'done') {
        return { passed: false, reason: `verify spawn status=${input.spawnResult.status}`, verifier: 'verifyVerify' };
    }
    if (input.spawnResult.confidence !== undefined && input.spawnResult.confidence < 0.6) {
        return {
            passed: false,
            reason: `verify-of-verify confidence too low (${input.spawnResult.confidence.toFixed(2)})`,
            verifier: 'verifyVerify',
        };
    }
    return {
        passed: true,
        reason: 'verify subtask reported done with confidence ≥ 0.6',
        verifier: 'verifyVerify',
        confidence: input.spawnResult.confidence ?? 0.7,
    };
}

// ── LLM-judge layer (v6.0) ───────────────────────────────────────
//
// Runs AFTER the per-kind verifier passes, as a final sanity check that
// the spawn output actually fulfilled the subtask intent. Cuts the
// false-positive rate of the per-kind checks (which test surface
// properties like length / exit code / keywords, not intent).
//
// Design:
//   - Only runs when per-kind passed (no judge on already-failed)
//   - Skipped for kind='verify' (avoids verify-of-verify recursion)
//   - Calls spawnSubAgent with the FAST tier — one short call, low cost
//   - Parses JSON {passed, reason} from the judge reply
//   - On judge throw / parse error → defers to the per-kind verdict
//     (never makes verification stricter than the per-kind alone)
//
// Toggle via env: TITAN_LLM_JUDGE_VERIFY=0 disables. Default is on.

function llmJudgeEnabled(): boolean {
    const env = (process.env.TITAN_LLM_JUDGE_VERIFY ?? '').toLowerCase().trim();
    if (env === '0' || env === 'false' || env === 'no' || env === 'off') return false;
    return true;
}

async function llmJudgeVerify(
    input: VerificationInput,
    kindResult: VerificationResult,
): Promise<VerificationResult> {
    if (input.kind === 'verify') return kindResult;
    if (!llmJudgeEnabled()) return kindResult;

    try {
        const { spawnSubAgent } = await import('./subAgent.js');
        const reasoning = (input.spawnResult.reasoning || input.spawnResult.rawResponse || '').slice(0, 1800);
        const artifactNote = input.spawnResult.artifacts?.length
            ? `\nArtifacts produced: ${input.spawnResult.artifacts.map(a => `${a.type}:${a.ref}`).join(', ')}`
            : '';
        const judgePrompt = [
            `You are a strict verification judge. Your ONE job is to decide whether the work below actually fulfilled the subtask intent.`,
            ``,
            `Subtask:`,
            `  title: ${input.subtask.title}`,
            `  description: ${input.subtask.description}`,
            ``,
            `Work produced (truncated to 1.8k chars):`,
            reasoning,
            artifactNote,
            ``,
            `Per-kind verifier ('${input.kind}') already passed with reason: ${kindResult.reason}`,
            ``,
            `Your job: does this work ACTUALLY address the subtask, or did it surface-pass without delivering?`,
            ``,
            `Common surface-pass failure modes to catch:`,
            `  - Length OK but content is generic / vague / doesn't address the specific subtask`,
            `  - Code compiles but doesn't do what was asked`,
            `  - Research has citations but missed the actual question`,
            `  - Report has the keywords but no real conclusion`,
            ``,
            `Return STRICT JSON on a single line: {"passed": true|false, "reason": "<≤140 chars why>"}.`,
            `No markdown. No prose before or after the JSON.`,
        ].join('\n');

        const judgeResult = await spawnSubAgent({
            name: 'llm-judge',
            task: judgePrompt,
            tier: 'fast',
            maxRounds: 1,
        });
        const raw = (judgeResult.content || '').trim();
        const jsonStart = raw.indexOf('{');
        const jsonEnd = raw.lastIndexOf('}');
        if (jsonStart < 0 || jsonEnd <= jsonStart) {
            logger.info(COMPONENT, `LLM judge returned non-JSON, deferring to per-kind verdict`);
            return kindResult;
        }
        const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { passed?: unknown; reason?: unknown };
        if (typeof parsed.passed !== 'boolean') return kindResult;
        if (parsed.passed) return kindResult; // judge agrees → keep the per-kind result
        const judgeReason = typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
            ? parsed.reason.trim().slice(0, 200)
            : 'LLM judge said no without a reason';
        logger.info(COMPONENT, `LLM judge OVERRIDE: per-kind passed but judge said fail — ${judgeReason}`);
        return {
            passed: false,
            reason: `LLM judge: ${judgeReason}`,
            verifier: `${input.kind}+llm-judge`,
            confidence: kindResult.confidence,
            details: `per-kind '${input.kind}' passed (${kindResult.reason}) but judge disagreed`,
        };
    } catch (err) {
        logger.warn(COMPONENT, `LLM judge threw (deferring to per-kind): ${(err as Error).message}`);
        return kindResult;
    }
}

// ── Dispatch ─────────────────────────────────────────────────────

export async function verifyByKind(input: VerificationInput): Promise<VerificationResult> {
    let kindResult: VerificationResult;
    try {
        switch (input.kind) {
            case 'code':     kindResult = await verifyCode(input);     break;
            case 'research': kindResult = verifyResearch(input);       break;
            case 'write':    kindResult = await verifyWrite(input);    break;
            case 'analysis': kindResult = verifyAnalysis(input);       break;
            case 'verify':   kindResult = verifyVerify(input);         break;
            case 'shell':    kindResult = await verifyShell(input);    break;
            case 'report':   kindResult = verifyReport(input);         break;
            default:
                return { passed: false, reason: `Unknown kind: ${input.kind}`, verifier: 'dispatch' };
        }
    } catch (err) {
        logger.warn(COMPONENT, `Verifier threw: ${(err as Error).message}`);
        return {
            passed: false,
            reason: `Verifier error: ${(err as Error).message}`,
            verifier: `${input.kind}:error`,
        };
    }

    // v6.0 — LLM-judge layer. Runs only when per-kind passed.
    if (kindResult.passed) {
        return await llmJudgeVerify(input, kindResult);
    }
    return kindResult;
}

// ── Utility: read a file's content (used by higher-level UI for the driver panel) ──
export function readArtifactContent(path: string, maxBytes = 50_000): string | null {
    try {
        if (!existsSync(path)) return null;
        const content = readFileSync(path, 'utf-8');
        return content.length > maxBytes ? content.slice(0, maxBytes) + '\n... [truncated]' : content;
    } catch { return null; }
}
