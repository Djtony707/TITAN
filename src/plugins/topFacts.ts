/**
 * TITAN — TopFacts ContextEngine Plugin
 * Implements DeerFlow's "top 15 facts" persistent memory pattern.
 * Extracts, scores, decays, and injects user-specific facts into the context window.
 */
import type { ContextEnginePlugin } from './contextEngine.js';
import type { ChatMessage } from '../providers/base.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { TITAN_HOME } from '../utils/constants.js';
import logger from '../utils/logger.js';

const COMPONENT = 'TopFacts';
const FACTS_PATH = join(TITAN_HOME, 'top-facts.json');
const DECAY_HALF_LIFE_DAYS = 60;
const DEFAULT_MAX_FACTS = 15;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TopFact {
    content: string;
    score: number;
    lastUsed: string;
    source: string;
    createdAt: string;
    accessCount: number;
    type: 'preference' | 'correction' | 'expertise' | 'context' | 'pattern';
}

// ─── Pattern Detection ───────────────────────────────────────────────────────

interface DetectedFact {
    content: string;
    type: TopFact['type'];
}

const PATTERNS: { type: TopFact['type']; triggers: RegExp[] }[] = [
    {
        type: 'correction',
        triggers: [
            /^no[,.]?\s+/i,
            /^actually[,.]?\s+/i,
            /^not that[,.]?\s+/i,
            /\binstead\b/i,
            /^wrong[,.]?\s+/i,
            /^that'?s not right/i,
        ],
    },
    {
        type: 'preference',
        triggers: [
            /\bI prefer\b/i,
            /\bI like\b/i,
            /\bI want\b/i,
            /\bdon'?t do\b/i,
            /\balways use\b/i,
            /\bnever use\b/i,
            /\bI hate\b/i,
            /\bI love\b/i,
            /\bplease always\b/i,
            /\bplease don'?t\b/i,
            /\bplease never\b/i,
        ],
    },
    {
        type: 'expertise',
        triggers: [
            /\bI'?m a\b/i,
            /\bI work as\b/i,
            /\bmy role is\b/i,
            /\bI'?ve been doing\b/i,
            /\bmy job is\b/i,
            /\bI specialize in\b/i,
            /\bI'?m experienced in\b/i,
            /\byears of experience\b/i,
        ],
    },
    {
        type: 'context',
        triggers: [
            /\bmy project\b/i,
            /\bwe'?re building\b/i,
            /\bthe goal is\b/i,
            /\bour team\b/i,
            /\bwe use\b/i,
            /\bour stack\b/i,
            /\bmy codebase\b/i,
            /\bour company\b/i,
        ],
    },
];

const TYPE_SCORES: Record<TopFact['type'], number> = {
    correction: 0.9,
    preference: 0.85,
    expertise: 0.8,
    context: 0.7,
    pattern: 0.6,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadFacts(): TopFact[] {
    try {
        if (!existsSync(FACTS_PATH)) return [];
        const raw = readFileSync(FACTS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            logger.warn(COMPONENT, 'Facts file is not an array — resetting');
            return [];
        }
        // Validate each fact has required fields
        return parsed.filter(
            (f: unknown) =>
                typeof f === 'object' &&
                f !== null &&
                typeof (f as TopFact).content === 'string' &&
                typeof (f as TopFact).score === 'number' &&
                typeof (f as TopFact).type === 'string',
        ) as TopFact[];
    } catch (e) {
        logger.warn(COMPONENT, `Failed to load facts: ${(e as Error).message}`);
        return [];
    }
}

function saveFacts(facts: TopFact[]): void {
    try {
        const dir = dirname(FACTS_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        // Atomic-ish write: write to temp then rename
        const tmpPath = FACTS_PATH + '.tmp';
        writeFileSync(tmpPath, JSON.stringify(facts, null, 2), 'utf-8');
        renameSync(tmpPath, FACTS_PATH);
    } catch {
        // Fallback: direct write
        try {
            writeFileSync(FACTS_PATH, JSON.stringify(facts, null, 2), 'utf-8');
        } catch (writeErr) {
            logger.error(COMPONENT, `Failed to save facts: ${(writeErr as Error).message}`);
        }
    }
}

function fuzzyMatch(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    if (wordsA.size === 0 && wordsB.size === 0) return 1;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let overlap = 0;
    for (const w of wordsA) {
        if (wordsB.has(w)) overlap++;
    }
    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? overlap / union : 0;
}

function applyDecay(facts: TopFact[]): TopFact[] {
    const now = Date.now();
    return facts.map((f) => {
        const lastUsed = new Date(f.lastUsed).getTime();
        if (isNaN(lastUsed)) return f;
        const daysSinceLastUsed = (now - lastUsed) / (1000 * 60 * 60 * 24);
        const decayFactor = daysSinceLastUsed / DECAY_HALF_LIFE_DAYS;
        const decayedScore = f.score * (1 - decayFactor);
        return { ...f, score: Math.max(0, Math.min(1, decayedScore)) };
    });
}

function detectFacts(text: string): DetectedFact[] {
    const results: DetectedFact[] = [];
    // Split on sentence boundaries
    const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => s.length > 5);

    for (const sentence of sentences) {
        for (const { type, triggers } of PATTERNS) {
            const matched = triggers.some((re) => re.test(sentence));
            if (matched) {
                results.push({ content: sentence, type });
                break; // First match wins per sentence
            }
        }
    }
    return results;
}

// ─── Plugin ──────────────────────────────────────────────────────────────────

export class TopFactsPlugin implements ContextEnginePlugin {
    readonly name = 'topFacts';
    readonly version = '1.0.0';

    private facts: TopFact[] = [];
    private maxFacts = DEFAULT_MAX_FACTS;

    async bootstrap(config: Record<string, unknown>): Promise<void> {
        if (typeof config.maxFacts === 'number' && config.maxFacts > 0) {
            this.maxFacts = config.maxFacts;
        }

        this.facts = loadFacts();
        this.facts = applyDecay(this.facts);
        this.facts.sort((a, b) => b.score - a.score);

        logger.info(COMPONENT, `Loaded ${this.facts.length} facts (max inject: ${this.maxFacts})`);
    }

    async assemble(context: ChatMessage[], _userMessage: string): Promise<ChatMessage[]> {
        if (this.facts.length === 0) return context;

        // Select top facts
        const topFacts = this.facts
            .sort((a, b) => b.score - a.score)
            .slice(0, this.maxFacts);

        if (topFacts.length === 0) return context;

        // Build injection block
        const lines = topFacts.map((f, i) => `${i + 1}. ${f.content}`);
        const injection = `\n\n## What I Know About You\n${lines.join('\n')}`;

        // Find and append to system message
        const result = context.map((msg) => {
            if (msg.role === 'system') {
                return { ...msg, content: msg.content + injection };
            }
            return msg;
        });

        // Update access metadata for injected facts
        const now = new Date().toISOString();
        for (const fact of topFacts) {
            fact.lastUsed = now;
            fact.accessCount = (fact.accessCount || 0) + 1;
        }

        saveFacts(this.facts);

        logger.debug(COMPONENT, `Injected ${topFacts.length} facts into context`);
        return result;
    }

    async afterTurn(turnResult: { content: string; toolsUsed: string[] }): Promise<void> {
        const detected = detectFacts(turnResult.content);
        if (detected.length === 0) return;

        const now = new Date().toISOString();
        let added = 0;
        let updated = 0;

        for (const { content, type } of detected) {
            // Check for duplicates via fuzzy match
            const existing = this.facts.find((f) => fuzzyMatch(f.content, content) > 0.6);

            if (existing) {
                // Update existing fact — keep higher score, refresh content
                existing.content = content;
                existing.score = Math.max(existing.score, TYPE_SCORES[type]);
                existing.lastUsed = now;
                existing.type = type;
                updated++;
            } else {
                // Add new fact
                this.facts.push({
                    content,
                    score: TYPE_SCORES[type],
                    lastUsed: now,
                    source: 'conversation',
                    createdAt: now,
                    accessCount: 0,
                    type,
                });
                added++;
            }
        }

        // Trim to maxFacts * 2 (buffer — assemble picks top maxFacts)
        const bufferSize = this.maxFacts * 2;
        if (this.facts.length > bufferSize) {
            this.facts.sort((a, b) => b.score - a.score);
            this.facts = this.facts.slice(0, bufferSize);
        }

        saveFacts(this.facts);

        if (added > 0 || updated > 0) {
            logger.debug(COMPONENT, `Facts: +${added} new, ~${updated} updated (total: ${this.facts.length})`);
        }
    }

    async ingest(content: string, metadata: Record<string, unknown>): Promise<void> {
        const type = (typeof metadata.type === 'string' && isValidType(metadata.type))
            ? metadata.type as TopFact['type']
            : 'context';

        const score = typeof metadata.score === 'number'
            ? Math.max(0, Math.min(1, metadata.score))
            : 0.7;

        const source = typeof metadata.source === 'string' ? metadata.source : 'external';
        const now = new Date().toISOString();

        // Deduplicate
        const existing = this.facts.find((f) => fuzzyMatch(f.content, content) > 0.6);
        if (existing) {
            existing.content = content;
            existing.score = Math.max(existing.score, score);
            existing.lastUsed = now;
            existing.source = source;
            logger.debug(COMPONENT, `Updated ingested fact (source: ${source})`);
        } else {
            this.facts.push({
                content,
                score,
                lastUsed: now,
                source,
                createdAt: now,
                accessCount: 0,
                type,
            });
            logger.debug(COMPONENT, `Ingested new fact (source: ${source}, type: ${type})`);
        }

        // Trim buffer
        const bufferSize = this.maxFacts * 2;
        if (this.facts.length > bufferSize) {
            this.facts.sort((a, b) => b.score - a.score);
            this.facts = this.facts.slice(0, bufferSize);
        }

        saveFacts(this.facts);
    }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

const VALID_TYPES = new Set<string>(['preference', 'correction', 'expertise', 'context', 'pattern']);

function isValidType(t: string): t is TopFact['type'] {
    return VALID_TYPES.has(t);
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTopFactsPlugin(): ContextEnginePlugin {
    return new TopFactsPlugin();
}
