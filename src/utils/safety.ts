/**
 * TITAN — Safety Utilities
 *
 * Pure, deterministic safety checks extracted from agent.ts for
 * unit-testability. Zero side effects, zero async.
 */

/**
 * Detect dangerous shell commands in a user message.
 * Matches: rm -rf variants, sudo, chmod 777.
 */
export function isDangerous(message: string): boolean {
    if (!message || typeof message !== 'string') return false;
    return (
        /\brm\s+-[a-zA-Z]*[rfRF]/.test(message) ||
        /\bsudo\b/.test(message) ||
        /\bchmod\s+777\b/.test(message)
    );
}

/**
 * Detect potentially dangerous shell commands (broader than isDangerous).
 * Used by shell hook pre-flight.
 */
export function isDangerousCommand(command: string): boolean {
    const DANGEROUS_PATTERNS = [
        /\brm\s+-[rfRF]/,
        />\s*\/dev\/null\s*2>&1.*rm/,
        /curl.*\|.*sh/,
        /wget.*\|.*sh/,
        /:(){ :|:& };:/, // fork bomb
        /dd\s+if=.+of=\/dev\//,
        /mkfs\./,
        />\s*\/etc\/passwd/,
        /shutdown\s+-h\s+now/,
    ];
    return DANGEROUS_PATTERNS.some(re => re.test(command));
}
