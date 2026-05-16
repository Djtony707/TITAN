/**
 * TITAN — Tool output cap.
 *
 * Why this exists
 * ---------------
 * Anthropic — "Writing effective tools for AI agents" — recommends a hard
 * cap on tool result size (Claude Code's default is 25,000 tokens). Past
 * that, the agent's context window fills up and either the next round
 * truncates or the request becomes too expensive to be useful.
 *
 * The harness fix is two-part:
 *   1. Cap the bytes before they reach the model.
 *   2. Append a TOOL-AWARE truncation hint that steers the agent toward
 *      a narrower call — `head -100` instead of `cat`, `startLine/endLine`
 *      instead of full read, smaller `maxLength` instead of full fetch.
 *      Without the hint, small models silently lose information and
 *      claim success; with it, they retry with corrected args.
 *
 * Implementation note: we cap by CHARACTER count, not token count. 4 chars
 * ≈ 1 token for English text; a 100,000-char cap ≈ 25,000 tokens. Token
 * counting requires the tokenizer for the active model — too provider-
 * coupled for a generic harness primitive. Char-count is good enough and
 * faster.
 *
 * Reference:
 *   - https://www.anthropic.com/engineering/writing-tools-for-agents
 *   - awesome-agent-harness top-10 pattern #4 (MCP / tool contracts)
 *   - 12 Factor §3 "Own your context window"
 */

/** Default cap in CHARACTERS. ~25 k tokens at 4 chars/token. */
export const DEFAULT_OUTPUT_CAP = 100_000;

/**
 * v6.1.0-alpha.55 — tools whose output IS a data URL the LLM is
 * meant to embed downstream. Truncating mid-base64 produces an
 * unusable URL, so these bypass the cap. download_image already
 * enforces its own 4 MB raw / ~5.3 MB base64 ceiling on the
 * source side; that's a tighter and more semantically correct
 * limit for this use case than the generic 100 KB context cap.
 *
 * Mirrors `DATA_URL_PRODUCING_TOOLS` in `toolRunner.ts` — keep
 * the lists in sync.
 */
const DATA_URL_PRODUCING_TOOLS = new Set<string>([
    'download_image',
]);

/** Per-call override options. */
export interface ToolOutputCapOptions {
    /** Override the cap in characters. */
    cap?: number;
}

/** Returned shape — content is the LLM-facing string with hint appended on truncation. */
export interface ToolOutputCapResult {
    /** The (possibly-truncated, possibly-stringified) content to send to the model. */
    content: string;
    /** True if the original was over the cap. */
    truncated: boolean;
    /** Original size in chars BEFORE truncation. Useful for telemetry. */
    originalSize: number;
    /** The tool-aware hint appended when truncated. null when not truncated. */
    hint: string | null;
}

/** Coerce any tool result into a UTF-8 string. */
function stringify(result: unknown): string {
    if (result === null || result === undefined) return '';
    if (typeof result === 'string') return result;
    if (typeof result === 'number' || typeof result === 'boolean') return String(result);
    try {
        return JSON.stringify(result);
    } catch {
        return String(result);
    }
}

/** Tool-aware truncation hints. Per-tool guidance steers the model toward a narrower retry. */
function buildHint(toolName: string, originalSize: number, capSize: number): string {
    const stats = `[truncated at ${capSize} chars; original was ${originalSize} chars]`;
    switch (toolName) {
        case 'shell':
        case 'execute_code':
        case 'exec':
            return `${stats}\n\nThe output was too large to return in full. Retry with a narrower command: pipe through grep/head/tail to filter, or run the command in pieces (e.g. one directory at a time).`;

        case 'read_file':
            return `${stats}\n\nThe file is too large to return in full. Retry read_file with startLine and endLine parameters to read a specific section. Or use shell with grep -n to find the lines you need first.`;

        case 'list_dir':
            return `${stats}\n\nThe directory has too many entries. Retry without recursive:true, or list a more specific subdirectory.`;

        case 'web_search':
            return `${stats}\n\nThe search returned too many results. Retry with a more specific query, or with a smaller maxResults (default 5).`;

        case 'web_fetch':
        case 'browse_url':
        case 'web_read':
            return `${stats}\n\nThe page is too large to return in full. Retry web_fetch with a smaller maxLength parameter to get just the section you need, or with extractMode:"text" to skip markdown overhead.`;

        case 'web_browse_llm':
        case 'web_act':
            return `${stats}\n\nThe browser-extracted content was too large. Retry with a more focused extraction prompt that targets a specific section of the page.`;

        case 'graph_search':
        case 'memory':
            return `${stats}\n\nToo many memory hits. Retry with a more specific query, or a lower limit parameter.`;

        case 'gallery_search':
            return `${stats}\n\nGallery search returned too many templates. Retry with a more specific query.`;

        default:
            return `${stats}\n\nThe tool returned too much data to fit in the context window. Retry with a narrower scope or a smaller limit/maxResults parameter.`;
    }
}

/**
 * Cap a tool's output at the configured character limit. Returns the
 * (possibly-truncated) content with a tool-aware steering hint when
 * truncation occurs.
 *
 * Pure function. Never throws (stringify catches JSON.stringify errors).
 */
export function capToolOutput(toolName: string, result: unknown, opts?: ToolOutputCapOptions): ToolOutputCapResult {
    const cap = opts?.cap ?? DEFAULT_OUTPUT_CAP;
    const stringified = stringify(result);
    const originalSize = stringified.length;

    // v6.1.0-alpha.55 — bypass cap for data-URL producing tools.
    // Truncating mid-base64 yields an unusable URL; the tool's own
    // source-side byte limit is the right control here.
    if (DATA_URL_PRODUCING_TOOLS.has(toolName)) {
        return { content: stringified, truncated: false, originalSize, hint: null };
    }

    if (originalSize <= cap) {
        return { content: stringified, truncated: false, originalSize, hint: null };
    }

    const hint = buildHint(toolName, originalSize, cap);
    const sliced = stringified.slice(0, cap);
    return {
        content: `${sliced}\n\n${hint}`,
        truncated: true,
        originalSize,
        hint,
    };
}
