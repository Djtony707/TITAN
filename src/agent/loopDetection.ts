/**
 * TITAN — Loop Detection & Circuit Breaker
 * Detects and prevents infinite tool-call loops that plague Auto-GPT and similar agents.
 * This is a TITAN-exclusive feature that makes it more reliable than all competitors.
 *
 * Detectors:
 * 1. genericRepeat — same tool + same params called repeatedly
 * 2. knownPollNoProgress — repeating poll tools with identical outputs
 * 3. pingPong — alternating A/B/A/B patterns with no progress
 */
import logger from '../utils/logger.js';

const COMPONENT = 'LoopDetection';

interface ToolCallRecord {
    toolName: string;
    argsHash: string;
    outputHash: string;
    timestamp: number;
}

interface LoopDetectionConfig {
    enabled: boolean;
    warningThreshold: number;
    criticalThreshold: number;
    globalCircuitBreakerThreshold: number;
    historySize: number;
}

const DEFAULT_CONFIG: LoopDetectionConfig = {
    enabled: true,
    warningThreshold: 5,
    criticalThreshold: 10,
    globalCircuitBreakerThreshold: 20,
    historySize: 30,
};

/**
 * Get config with autonomy-aware overrides.
 * In autonomous mode, the circuit breaker threshold is raised (configurable).
 */
export function getAutonomousConfig(overrides?: Partial<LoopDetectionConfig>): Partial<LoopDetectionConfig> {
    return {
        ...overrides,
        // Caller passes the higher threshold from config.autonomy.circuitBreakerOverride
    };
}

const sessionHistory: Map<string, ToolCallRecord[]> = new Map();
// Per-session call counts (reset when session history is cleared)
const sessionCallCounts: Map<string, number> = new Map();

/** Simple fast hash for comparison */
function fastHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit int
    }
    return hash.toString(36);
}

/** Record a tool call and check for loops */
export function checkForLoop(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    output: string,
    config: Partial<LoopDetectionConfig> = {},
): { allowed: boolean; reason?: string; level: 'ok' | 'warning' | 'critical' | 'circuit_breaker' } {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    if (!cfg.enabled) return { allowed: true, level: 'ok' };

    const argsHash = fastHash(JSON.stringify(args));
    const outputHash = fastHash(output);
    const record: ToolCallRecord = { toolName, argsHash, outputHash, timestamp: Date.now() };

    // Get or create session history
    if (!sessionHistory.has(sessionId)) {
        sessionHistory.set(sessionId, []);
    }
    const history = sessionHistory.get(sessionId)!;
    history.push(record);

    // Trim history
    if (history.length > cfg.historySize) {
        history.splice(0, history.length - cfg.historySize);
    }

    // Per-session call counter (single-threaded: no await between read/write, so this is atomic)
    const sessionCalls = (sessionCallCounts.get(sessionId) || 0) + 1;
    sessionCallCounts.set(sessionId, sessionCalls);

    // Check per-session circuit breaker
    if (sessionCalls > cfg.globalCircuitBreakerThreshold) {
        logger.error(COMPONENT, `Session circuit breaker tripped: ${sessionCalls} calls in session ${sessionId}`);
        return {
            allowed: false,
            reason: `Session circuit breaker: ${sessionCalls} tool calls in this session. Stopping to prevent runaway execution.`,
            level: 'circuit_breaker',
        };
    }

    // Detector 1: Generic repeat (same tool + same args)
    const repeatCount = countConsecutiveRepeats(history);
    if (repeatCount >= cfg.criticalThreshold) {
        logger.error(COMPONENT, `Critical loop detected: ${toolName} called ${repeatCount}x with same args`);
        return {
            allowed: false,
            reason: `Loop detected: "${toolName}" called ${repeatCount} times with identical arguments. Breaking loop.`,
            level: 'critical',
        };
    }
    if (repeatCount >= cfg.warningThreshold) {
        logger.warn(COMPONENT, `Warning: ${toolName} called ${repeatCount}x with same args`);
        return {
            allowed: true,
            reason: `Warning: "${toolName}" called ${repeatCount} times with same arguments. Consider a different approach.`,
            level: 'warning',
        };
    }

    // Detector 2: Poll with no progress (same tool, same output)
    const noProgressCount = countNoProgressPolls(history);
    if (noProgressCount >= cfg.criticalThreshold) {
        logger.error(COMPONENT, `No-progress loop: ${toolName} returning same output ${noProgressCount}x`);
        return {
            allowed: false,
            reason: `No progress detected: "${toolName}" returning identical output ${noProgressCount} times. Breaking loop.`,
            level: 'critical',
        };
    }

    // Detector 3: Ping-pong pattern (A→B→A→B)
    const pingPong = detectPingPong(history);
    if (pingPong) {
        logger.error(COMPONENT, `Ping-pong loop detected: ${pingPong}`);
        return {
            allowed: false,
            reason: `Ping-pong pattern detected: ${pingPong}. Breaking loop.`,
            level: 'critical',
        };
    }

    return { allowed: true, level: 'ok' };
}

/** Count consecutive calls with same tool + same args at the end of history */
function countConsecutiveRepeats(history: ToolCallRecord[]): number {
    if (history.length < 2) return 1;
    const last = history[history.length - 1];
    let count = 1;
    for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].toolName === last.toolName && history[i].argsHash === last.argsHash) {
            count++;
        } else {
            break;
        }
    }
    return count;
}

/** Count consecutive tool calls returning the same output WITH same args.
 *  Only flags as "no progress" if both args and output are identical —
 *  reading the same file 5x is a loop, but reading 5 different files
 *  that happen to have similar output is not. */
function countNoProgressPolls(history: ToolCallRecord[]): number {
    if (history.length < 2) return 1;
    const last = history[history.length - 1];
    let count = 1;
    for (let i = history.length - 2; i >= 0; i--) {
        if (history[i].toolName === last.toolName
            && history[i].argsHash === last.argsHash
            && history[i].outputHash === last.outputHash) {
            count++;
        } else {
            break;
        }
    }
    return count;
}

/** Tool pairs that are normal research patterns, not loops */
const ALLOWED_PING_PONG_PAIRS: ReadonlySet<string> = new Set([
    'web_search|web_fetch',
    'web_fetch|web_search',
    'web_search|web_read',
    'web_read|web_search',
    'web_fetch|web_read',
    'web_read|web_fetch',
    'read_file|list_dir',
    'list_dir|read_file',
    'smart_form_fill|web_act',
    'web_act|smart_form_fill',
]);

/** Detect A→B→A→B ping-pong patterns (excludes valid research pairs) */
function detectPingPong(history: ToolCallRecord[]): string | null {
    if (history.length < 6) return null;

    const last6 = history.slice(-6);
    // Check if it alternates between exactly 2 tools
    const tools = [...new Set(last6.map((r) => r.toolName))];
    if (tools.length !== 2) return null;

    // Verify alternating pattern
    const isAlternating = last6.every((r, i) => r.toolName === tools[i % 2]);
    if (!isAlternating) return null;

    // Allow known research patterns (web_search ↔ web_fetch is normal)
    const pairKey = `${tools[0]}|${tools[1]}`;
    if (ALLOWED_PING_PONG_PAIRS.has(pairKey)) {
        // Only flag if args are also identical (true loop, not research)
        const argsHashes = last6.map(r => r.argsHash);
        const uniqueArgs = new Set(argsHashes);
        if (uniqueArgs.size > 2) {
            // Different args each time = genuine research, not a loop
            return null;
        }
    }

    return `${tools[0]} ↔ ${tools[1]} repeated 3+ times`;
}

/** Reset loop detection for a session */
export function resetLoopDetection(sessionId: string): void {
    sessionHistory.delete(sessionId);
    sessionCallCounts.delete(sessionId);
}

/** Get loop detection stats */
export function getLoopStats(): { sessions: number; totalCalls: number } {
    let totalCalls = 0;
    for (const count of sessionCallCounts.values()) totalCalls += count;
    return {
        sessions: sessionHistory.size,
        totalCalls,
    };
}
