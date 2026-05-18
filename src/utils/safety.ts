/**
 * TITAN — Safety Utilities
 *
 * Pure, deterministic safety checks extracted from agent.ts for
 * unit-testability. Zero side effects, zero async.
 */

/**
 * Detect dangerous shell commands in a user message.
 * Matches: destructive shell patterns, privileged commands, and obvious
 * command-injection vectors. This is intentionally broader than the shell
 * hook scanner because agent-level routing must refuse before tool selection.
 */
export function isDangerous(message: string): boolean {
    if (!message || typeof message !== 'string') return false;
    const dangerousPatterns = [
        /\brm\s+-[a-zA-Z]*[rfRF]/,
        /\bsudo\b/,
        /\bchmod\s+777\b/,
        /\bcurl\b[^|\n;]*(?:\|\s*(?:ba)?sh\b)/,
        /\bwget\b[^|\n;]*(?:\|\s*(?:ba)?sh\b)/,
        /\|\s*(?:bash|sh|zsh|python|perl|ruby)\b/,
        /\b(?:run|execute)\b[^;\n]*[;`]|`[^`]+`/,
        /(?:^|[/"'\s])\.\.\/\.\.\//,
        /\b(?:fetch|download|open|read)\s+(?:file|dict|gopher):\/\//,
    ];
    return dangerousPatterns.some(re => re.test(message));
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

// ── Argument Red-Team Validators (Phase 6) ───────────────────────

/**
 * Detect path traversal in a file path argument.
 * Matches: `..` sequences, absolute paths, home directory `~`.
 */
export function isPathTraversal(path: string): boolean {
    if (!path || typeof path !== 'string') return false;
    const normalized = path.trim();
    // .. anywhere in the path
    if (/(?:^|\/)\.\.(?:\/|$)/.test(normalized)) return true;
    // Absolute path
    if (normalized.startsWith('/')) return true;
    // Home directory expansion
    if (normalized.startsWith('~')) return true;
    return false;
}

/**
 * Detect shell metacharacters that could enable injection.
 * Matches: `;` `|` `&` `` ` `` `$()` `${}` `<` `>`.
 */
export function hasShellMetacharacters(command: string): boolean {
    if (!command || typeof command !== 'string') return false;
    return /[;|&`$(){}<>]/.test(command);
}

/**
 * Detect command chaining operators.
 * Matches: `;` `&&` `||` `|` (pipe).
 */
export function isCommandChaining(command: string): boolean {
    if (!command || typeof command !== 'string') return false;
    return /[;|&]/.test(command);
}

/**
 * Detect dangerous URL schemes (SSRF / local file access vectors).
 * Blocks: file://, dict://, gopher://, ftp://, sftp://
 */
export function isDangerousUrl(url: string): boolean {
    if (!url || typeof url !== 'string') return false;
    try {
        const parsed = new URL(url);
        const blockedSchemes = ['file:', 'dict:', 'gopher:', 'ftp:', 'sftp:'];
        return blockedSchemes.includes(parsed.protocol);
    } catch {
        return false;
    }
}
