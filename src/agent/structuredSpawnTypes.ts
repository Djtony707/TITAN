/**
 * TITAN — Structured Spawn types (v4.10.0-local, Phase A)
 *
 * Extracted so verifier.ts and goalDriverTypes.ts can import the
 * StructuredSpawnResult shape without pulling in subAgent.ts.
 */

export type StructuredSpawnStatus = 'done' | 'failed' | 'needs_info' | 'blocked';

export interface StructuredArtifact {
    type: 'file' | 'url' | 'fact' | 'report';
    ref: string;
    description?: string;
}

export interface StructuredSpawnResult {
    status: StructuredSpawnStatus;
    artifacts: StructuredArtifact[];
    questions: string[];
    confidence: number; // 0-1
    reasoning: string;
    rawResponse: string;
    /** Specialist id used for this spawn. */
    specialistId?: string;
    /** Tool calls made by the specialist — for audit + UI. */
    toolsUsed?: string[];
    /** Duration — used by budget accounting. */
    durationMs?: number;
    /** Tokens consumed — used by budget accounting. */
    tokensUsed?: number;
    /** Cost — used by budget accounting. */
    costUsd?: number;
    /** Populated if the parser couldn't find the JSON block. */
    parseError?: string;
}
