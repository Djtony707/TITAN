/**
 * TITAN v5.0 — Filesystem Checkpoint Types
 */

export interface CheckpointEntry {
    id: string;
    sessionId: string;
    timestamp: string;
    toolName: string;
    toolArgs: Record<string, unknown>;
    snapshots: Array<{
        originalPath: string;
        snapshotPath: string;
        hash: string;
    }>;
}
