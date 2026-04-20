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

// ── Dispatch ─────────────────────────────────────────────────────

export async function verifyByKind(input: VerificationInput): Promise<VerificationResult> {
    try {
        switch (input.kind) {
            case 'code':     return await verifyCode(input);
            case 'research': return verifyResearch(input);
            case 'write':    return await verifyWrite(input);
            case 'analysis': return verifyAnalysis(input);
            case 'verify':   return verifyVerify(input);
            case 'shell':    return await verifyShell(input);
            case 'report':   return verifyReport(input);
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
}

// ── Utility: read a file's content (used by higher-level UI for the driver panel) ──
export function readArtifactContent(path: string, maxBytes = 50_000): string | null {
    try {
        if (!existsSync(path)) return null;
        const content = readFileSync(path, 'utf-8');
        return content.length > maxBytes ? content.slice(0, maxBytes) + '\n... [truncated]' : content;
    } catch { return null; }
}
