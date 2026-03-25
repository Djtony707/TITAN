/**
 * TITAN — Hindsight MCP Bridge
 * Connects TITAN's learning system to Vectorize.io's Hindsight episodic memory.
 * When Hindsight MCP is connected, strategies are retained as "experience" memories
 * and cross-session recall is used to supplement local strategy hints.
 *
 * This bridge is fire-and-forget — if Hindsight isn't connected, all operations
 * silently return without error. No core TITAN functionality depends on it.
 */
import { getMcpConnections } from '../mcp/client.js';
import { getRegisteredTools } from '../agent/toolRunner.js';
import logger from '../utils/logger.js';

const COMPONENT = 'Hindsight';

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Check if Hindsight MCP is connected */
export function isHindsightConnected(): boolean {
    try {
        const conns = getMcpConnections();
        return conns.some(c => c.server.id === 'hindsight' && c.status === 'connected');
    } catch {
        return false;
    }
}

/** Find a Hindsight MCP tool by suffix (e.g. 'retain', 'recall', 'reflect') */
function findHindsightTool(suffix: string): ((args: Record<string, unknown>) => Promise<string>) | null {
    try {
        const tools = getRegisteredTools();
        const match = tools.find(t =>
            t.name.startsWith('mcp_hindsight_') && t.name.endsWith(suffix),
        );
        return match?.execute ?? null;
    } catch {
        return null;
    }
}

// ─── Retain: Store a memory ──────────────────────────────────────────────

type HindsightNetwork = 'experience' | 'world' | 'opinion' | 'observation';

/**
 * Store a memory in Hindsight's episodic network.
 * Fire-and-forget — never throws.
 */
export async function retainToHindsight(
    content: string,
    network: HindsightNetwork = 'experience',
): Promise<void> {
    if (!isHindsightConnected()) return;

    const retain = findHindsightTool('retain');
    if (!retain) return;

    try {
        await retain({ content, network });
        logger.debug(COMPONENT, `Retained ${network} memory (${content.length} chars)`);
    } catch (e) {
        logger.warn(COMPONENT, `Retain failed: ${(e as Error).message}`);
    }
}

// ─── Recall: Query memories ─────────────────────────────────────────────

/**
 * Recall memories from Hindsight related to a query.
 * Returns null if Hindsight isn't available or recall fails.
 */
export async function recallFromHindsight(query: string): Promise<string | null> {
    if (!isHindsightConnected()) return null;

    const recall = findHindsightTool('recall');
    if (!recall) return null;

    try {
        const result = await recall({ query, limit: 3 });
        if (result && result !== 'No output' && result.trim().length > 0) {
            logger.debug(COMPONENT, `Recalled ${result.length} chars for query "${query.slice(0, 50)}"`);
            return result;
        }
        return null;
    } catch (e) {
        logger.warn(COMPONENT, `Recall failed: ${(e as Error).message}`);
        return null;
    }
}

// ─── Strategy Bridge ────────────────────────────────────────────────────

/**
 * After a successful strategy is recorded, retain it as Hindsight experience.
 * Called from agent.ts post-turn learning (fire-and-forget).
 */
export async function retainStrategy(
    taskType: string,
    toolSequence: string[],
    successCount: number,
    pattern: string,
): Promise<void> {
    const content = [
        `Task type: ${taskType}`,
        `Tool sequence: ${toolSequence.join(' → ')}`,
        `Success count: ${successCount}`,
        `Pattern: ${pattern.slice(0, 200)}`,
    ].join('\n');

    await retainToHindsight(content, 'experience');
}

/**
 * Query Hindsight for cross-session strategy hints.
 * Falls back to null if nothing relevant found or Hindsight unavailable.
 */
export async function getHindsightHints(message: string): Promise<string | null> {
    const result = await recallFromHindsight(`strategy for: ${message.slice(0, 150)}`);
    if (!result) return null;

    return `[Cross-session memory] ${result.slice(0, 500)}`;
}
