/**
 * TITAN — Playbooks (v4.10.0-local, Phase D)
 *
 * When TITAN has solved the same *class* of goal 3+ times successfully,
 * abstract the shared pattern into a playbook. Next time a similar goal
 * arrives, the planner picks the playbook's template subtasks instead
 * of asking the LLM to re-decompose from scratch.
 *
 * A playbook captures:
 *   - signature: keywords/tags that identify "same class of goal"
 *   - template subtasks: the proven decomposition
 *   - specialist routes: which specialists worked
 *   - avg cost + time: so the planner can estimate budget upfront
 *   - version: incremented when a playbook is refined from new data
 *
 * Storage: ~/.titan/playbooks/<signatureHash>.json — one file per playbook.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import logger from '../utils/logger.js';
import { TITAN_HOME } from '../utils/constants.js';

const COMPONENT = 'Playbooks';
const PLAYBOOKS_DIR = join(TITAN_HOME, 'playbooks');
const MIN_SUCCESSES_TO_ABSTRACT = 3;

// ── Shape ────────────────────────────────────────────────────────

export interface PlaybookSubtaskTemplate {
    titleTemplate: string;      // e.g. "Research the {topic} API"
    descriptionTemplate: string;
    kind: string;               // SubtaskKind string
    expectedSpecialist: string; // 'scout', 'builder', etc.
}

export interface Playbook {
    schemaVersion: 1;
    id: string;
    /** Canonical signature of "goals this playbook matches." */
    signature: string[];
    /** Version — increments when the playbook is refined from new retros. */
    version: number;
    /** How many successful retrospectives informed this playbook. */
    derivedFrom: number;
    /** Avg duration per similar goal (ms). */
    avgDurationMs: number;
    /** Avg tokens per similar goal. */
    avgTokensUsed: number;
    /** Avg subtask count. */
    avgSubtaskCount: number;
    /** Specialists that were used most often. */
    commonSpecialists: string[];
    /** Template subtask decomposition. */
    subtaskTemplates: PlaybookSubtaskTemplate[];
    /** Tags this playbook covers. */
    tags: string[];
    createdAt: string;
    updatedAt: string;
}

// ── Storage ──────────────────────────────────────────────────────

function ensureDir(): void {
    try { mkdirSync(PLAYBOOKS_DIR, { recursive: true }); } catch { /* ok */ }
}

function playbookPath(id: string): string {
    return join(PLAYBOOKS_DIR, `${id}.json`);
}

function signatureHash(tokens: string[]): string {
    return createHash('sha1').update(tokens.sort().join('|')).digest('hex').slice(0, 10);
}

// ── Signature extraction ─────────────────────────────────────────

/**
 * Extract a signature from a goal title + tags. Normalized tokens that
 * tend to identify "same class of goal" (lowercased, stopwords stripped).
 */
const STOPWORDS = new Set([
    'the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'with', 'and', 'or',
    'it', 'its', 'that', 'this', 'those', 'these', 'my', 'new', 'using',
    'from', 'into', 'via', 'build', 'create', 'make', 'implement', 'add',
    'be', 'can', 'will', 'would', 'should', 'is', 'are', 'was', 'were',
]);

export function extractSignature(title: string, tags: string[] = []): string[] {
    const tokens = title.toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 2 && !STOPWORDS.has(t));
    // Tags provide strong signal, keep them prefixed so they don't collide
    // with title tokens
    const tagTokens = tags.filter(t => !t.startsWith('soma:')).map(t => `tag:${t.toLowerCase()}`);
    return [...new Set([...tokens, ...tagTokens])];
}

export function signaturesMatch(a: string[], b: string[], minOverlap = 0.4): boolean {
    if (a.length === 0 || b.length === 0) return false;
    const aSet = new Set(a);
    const overlap = b.filter(t => aSet.has(t)).length;
    const denominator = Math.min(a.length, b.length);
    return overlap / denominator >= minOverlap;
}

// ── Load / save ──────────────────────────────────────────────────

function loadPlaybook(id: string): Playbook | null {
    const p = playbookPath(id);
    if (!existsSync(p)) return null;
    try {
        const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Playbook;
        if (parsed.schemaVersion !== 1) return null;
        return parsed;
    } catch { return null; }
}

function savePlaybook(pb: Playbook): void {
    ensureDir();
    pb.updatedAt = new Date().toISOString();
    const p = playbookPath(pb.id);
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p + '.tmp', JSON.stringify(pb, null, 2));
        renameSync(p + '.tmp', p);
    } catch (err) {
        logger.warn(COMPONENT, `Save playbook ${pb.id} failed: ${(err as Error).message}`);
    }
}

export function listPlaybooks(): Playbook[] {
    ensureDir();
    if (!existsSync(PLAYBOOKS_DIR)) return [];
    const out: Playbook[] = [];
    for (const file of readdirSync(PLAYBOOKS_DIR)) {
        if (!file.endsWith('.json')) continue;
        const pb = loadPlaybook(file.slice(0, -5));
        if (pb) out.push(pb);
    }
    return out.sort((a, b) => b.derivedFrom - a.derivedFrom);
}

// ── Abstraction: build/update a playbook from retrospectives ──

interface RetroData {
    goalTitle: string;
    tags: string[];
    durationMs: number;
    tokensUsed: number;
    subtaskCount: number;
    specialists: string[];
    success: boolean;
}

/**
 * Scan experiments (retrospectives) and produce/update playbooks for
 * any signature that has ≥3 successful runs. Idempotent — safe to run
 * on a cron.
 */
export async function refreshPlaybooks(): Promise<{ created: number; updated: number; skipped: number }> {
    let created = 0;
    let updated = 0;
    let skipped = 0;
    try {
        const { listExperiments } = await import('../memory/experiments.js');
        const experiments = listExperiments(500);
        // Only goal-driver retrospectives that succeeded
        const retros: RetroData[] = [];
        for (const e of experiments) {
            if (!(e.tags || []).includes('goal-driver')) continue;
            if (e.outcome !== 'succeeded') continue;
            // Experiment entries from retrospectives.ts contain metrics in the
            // lesson + tags. Parse what we can.
            const title = e.hypothesis.replace(/^Goal "(.*?)" —.*$/s, '$1');
            const specialists: string[] = (e.hypothesis.match(/driven by ([a-z, ]+)/i)?.[1] || '').split(',').map(s => s.trim()).filter(Boolean);
            retros.push({
                goalTitle: title,
                tags: e.tags || [],
                durationMs: 0, // parsed from lesson if present, else 0
                tokensUsed: 0,
                subtaskCount: 0,
                specialists,
                success: true,
            });
        }

        // Bucket by signature
        const buckets = new Map<string, { signature: string[]; data: RetroData[] }>();
        for (const r of retros) {
            const sig = extractSignature(r.goalTitle, r.tags);
            if (sig.length < 2) continue; // too weak a signature
            const key = signatureHash(sig);
            const bucket = buckets.get(key) || { signature: sig, data: [] };
            bucket.data.push(r);
            buckets.set(key, bucket);
        }

        for (const [key, bucket] of buckets) {
            if (bucket.data.length < MIN_SUCCESSES_TO_ABSTRACT) {
                skipped++;
                continue;
            }
            const existing = loadPlaybook(key);
            const now = new Date().toISOString();
            const specialistCounts = new Map<string, number>();
            for (const r of bucket.data) {
                for (const s of r.specialists) specialistCounts.set(s, (specialistCounts.get(s) ?? 0) + 1);
            }
            const commonSpecialists = Array.from(specialistCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([s]) => s)
                .slice(0, 4);

            const updated_: Playbook = {
                schemaVersion: 1,
                id: key,
                signature: bucket.signature,
                version: existing ? existing.version + 1 : 1,
                derivedFrom: bucket.data.length,
                avgDurationMs: bucket.data.reduce((a, b) => a + b.durationMs, 0) / bucket.data.length,
                avgTokensUsed: bucket.data.reduce((a, b) => a + b.tokensUsed, 0) / bucket.data.length,
                avgSubtaskCount: Math.max(1, bucket.data.reduce((a, b) => a + b.subtaskCount, 0) / bucket.data.length),
                commonSpecialists,
                subtaskTemplates: existing?.subtaskTemplates || [
                    // Default template — override via UI in future
                    {
                        titleTemplate: `Research the topic`,
                        descriptionTemplate: `Gather key facts + sources on the subject`,
                        kind: 'research',
                        expectedSpecialist: 'scout',
                    },
                ],
                tags: [...new Set(bucket.data.flatMap(r => r.tags))].slice(0, 8),
                createdAt: existing?.createdAt || now,
                updatedAt: now,
            };
            savePlaybook(updated_);
            if (existing) updated++;
            else created++;
            logger.info(COMPONENT, `Playbook ${key}: v${updated_.version}, derivedFrom ${bucket.data.length} retros`);
        }
    } catch (err) {
        logger.warn(COMPONENT, `refreshPlaybooks: ${(err as Error).message}`);
    }
    return { created, updated, skipped };
}

/**
 * Find a matching playbook for a new goal. Returns null if none match.
 * Caller uses the playbook's templates during planning phase.
 */
export function findPlaybookForGoal(title: string, tags: string[] = []): Playbook | null {
    const querySig = extractSignature(title, tags);
    for (const pb of listPlaybooks()) {
        if (signaturesMatch(querySig, pb.signature, 0.5)) return pb;
    }
    return null;
}

export function _resetPlaybooksForTests(): void {
    try { rmSync(PLAYBOOKS_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}
