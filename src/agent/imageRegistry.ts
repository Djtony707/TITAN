/**
 * TITAN — Image Registry side-channel (v6.1.0-alpha.56)
 *
 * Tony's escalation: "FIX THE NO IMAGE IN ESSAY PROBLEM!!!!!"
 *
 * The problem (root cause, not symptom):
 *
 * `download_image` (alpha.37) returns a 270 KB–800 KB base64
 * data URL. Even after alpha.55 exempted the tool from
 * ToolRunner's three trim layers, the LLM still has to round-trip
 * that string through its context AND emit it verbatim inside a
 * `write_file({content: …})` call. LLMs:
 *
 *   - Truncate huge strings silently when emitting
 *   - Avoid pasting 200 KB blobs because their training rewards brevity
 *   - Hit subtle context limits at the chat-turn boundary
 *   - Burn ~70 K tokens per round-trip per image, slowing everything
 *
 * Even when everything works, generating 1 essay with 2 images
 * means the Writer holds ~150 K tokens of base64 in working memory,
 * crowding out the actual prose.
 *
 * The fix is to NOT pass the base64 through the LLM at all.
 *
 * How this module works:
 *
 *   1. `download_image` calls `registerImage(dataUrl, mimeType)`
 *      which:
 *        - Stores `dataUrl` in a module-level Map keyed by
 *          a short content-hash
 *        - Returns a short opaque token: `tdi://abc123def456`
 *
 *   2. `download_image` returns that token to the LLM as the
 *      `dataUrl` field. From the LLM's perspective it looks like
 *      a normal URL — short, opaque, embeddable.
 *
 *   3. The Writer pastes the token into HTML as
 *      `<img src="tdi://abc123def456" alt="…">`.
 *
 *   4. When `write_file` / `append_file` / `edit_file` write the
 *      content to disk, they call `resolveImageReferences(content)`
 *      first, which substitutes every `tdi://...` token with the
 *      real `data:image/…;base64,…` URL from the registry.
 *
 *   5. The file on disk has the full data URL embedded, so the
 *      FileViewer renders the image normally — the HTML is
 *      self-contained and portable.
 *
 * Properties:
 *
 *   - Token is ~30 chars regardless of image size → LLM context
 *     stays small, generation stays fast, truncation impossible
 *   - LLM never has to emit a 200 KB literal → robustness across
 *     models
 *   - Registry is process-local and bounded (LRU with 64-entry cap)
 *     → no memory leak from long-running sessions
 *   - Tokens are content-hashed → identical images dedupe automatically
 *
 * Why "tdi://" and not "data:"
 *
 *   - "data:" prefix would make ToolRunner's `sanitizeBase64` strip
 *     the token, defeating the whole point.
 *   - "tdi://" looks URL-like enough that LLMs and HTML parsers
 *     both accept it as a `src` value without rewriting it.
 *   - It's a private scheme so collisions with real URLs are
 *     impossible.
 */

import { createHash } from 'crypto';

interface RegistryEntry {
    /** Full data: URL ready to embed in HTML. */
    dataUrl: string;
    /** MIME type for diagnostic / logging only. */
    mimeType: string;
    /** When this entry was last accessed (ms epoch). Used for LRU. */
    lastTouched: number;
    /** Original byte size of the decoded image. */
    sizeBytes: number;
}

/** Cap to prevent unbounded growth in long-running sessions. */
const MAX_REGISTRY_SIZE = 64;

/** Module-level registry. Keyed by content hash (first 16 hex chars). */
const REGISTRY = new Map<string, RegistryEntry>();

/** Scheme used in tokens. Don't change without coordinating resolver call sites. */
export const TDI_SCHEME = 'tdi://';

/**
 * Regex to detect TDI tokens anywhere in a string. The hash is
 * 16 hex chars — `[a-f0-9]{16}`. Word-boundary on the trailing
 * end so adjacent characters (quote, space, >) don't get included.
 */
const TDI_TOKEN_RE = /tdi:\/\/([a-f0-9]{16})/g;

/**
 * Stash a data URL in the registry and return its short token.
 *
 * Content-hashed so the same image submitted twice returns the
 * same token (dedupe). LRU-bounded so memory stays sane.
 */
export function registerImage(dataUrl: string, mimeType: string, sizeBytes: number): string {
    const hash = createHash('sha256').update(dataUrl).digest('hex').slice(0, 16);
    const now = Date.now();
    const existing = REGISTRY.get(hash);
    if (existing) {
        existing.lastTouched = now;
    } else {
        REGISTRY.set(hash, { dataUrl, mimeType, lastTouched: now, sizeBytes });
        evictLRUIfOverCap();
    }
    return `${TDI_SCHEME}${hash}`;
}

/**
 * Replace every `tdi://hash` token in `content` with the
 * corresponding data URL from the registry. Tokens with no
 * registry entry pass through unchanged (the FileViewer will
 * placeholder them via the alpha.52 broken-image rewrite).
 *
 * Pure on the registry — does not mutate it. Touches `lastTouched`
 * on hits so resolved images stay alive in the LRU.
 *
 * Called by `write_file`, `append_file`, `edit_file` before
 * writing content to disk. Also safe to call anywhere else that
 * persists agent-produced content (logs, snapshots, etc.).
 */
export function resolveImageReferences(content: string): string {
    if (typeof content !== 'string' || !content.includes(TDI_SCHEME)) return content;
    return content.replace(TDI_TOKEN_RE, (match, hash) => {
        const entry = REGISTRY.get(hash);
        if (!entry) return match; // unknown token — leave for placeholder fallback
        entry.lastTouched = Date.now();
        return entry.dataUrl;
    });
}

/** True if `content` contains at least one TDI token. */
export function hasImageReferences(content: string): boolean {
    return typeof content === 'string' && TDI_TOKEN_RE.test(content);
}

/** Number of currently-registered images. For diagnostics / tests. */
export function registrySize(): number {
    return REGISTRY.size;
}

/** Manual clear — primarily for tests. Safe to call from prod too. */
export function clearImageRegistry(): void {
    REGISTRY.clear();
}

function evictLRUIfOverCap(): void {
    if (REGISTRY.size <= MAX_REGISTRY_SIZE) return;
    let oldestKey: string | null = null;
    let oldestTouched = Infinity;
    for (const [key, entry] of REGISTRY.entries()) {
        if (entry.lastTouched < oldestTouched) {
            oldestTouched = entry.lastTouched;
            oldestKey = key;
        }
    }
    if (oldestKey) REGISTRY.delete(oldestKey);
}
