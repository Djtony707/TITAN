/**
 * TITAN v8 — Abstract task signatures (Self-Compiling Agent, Finding 1 fix)
 *
 * The one hard problem in the compile loop: a signature must match a
 * FAMILY of requests, not one literal message. "summarize /home/tony/a.txt"
 * and "summarize /tmp/b.txt" are the same task with different slot fills.
 *
 * This module normalizes high-confidence entities to typed placeholders
 * BEFORE the signature is computed, so byte-exact comparison on the
 * abstracted form groups the family:
 *
 *   "summarize /home/tony/a.txt"  →  "summarize {path}"
 *   "summarize /tmp/b.txt"        →  "summarize {path}"   (same signature)
 *
 * Zero-false-positive bar: a missed match costs one frontier run; a wrong
 * match replays the wrong recipe. So abstraction fires ONLY on unambiguous
 * forms — explicit path markers (/, ~, ./, ../), real URLs, quoted spans,
 * dates, standalone numbers. Bare filenames (`README.md`), bare words, and
 * anything ambiguous stay literal: two messages that differ in a literal
 * token NEVER share a signature.
 *
 * Kept in its own module (not inside recipeCompiler.ts) because both the
 * TraceStore (persist-time signature) and the compiler/router (match-time
 * signature) import it, and a shared home avoids an import cycle.
 */

import { createHash } from 'crypto';

export type SlotType = 'path' | 'url' | 'quoted' | 'date' | 'num';

/** One normalized entity: which placeholder replaced it and the original literal. */
export interface TypedSlot {
    type: SlotType;
    /** The placeholder written into the abstracted text, e.g. '{path}'. */
    placeholder: string;
    /** The original literal from the message, for slot-filling at replay. */
    value: string;
}

const PLACEHOLDER: Record<SlotType, string> = {
    path: '{path}',
    url: '{url}',
    quoted: '{quoted}',
    date: '{date}',
    num: '{num}',
};

// One combined regex, single pass. Alternative order is the priority at a
// given position — first match wins, no nesting:
//   1. quoted spans  ("..."/'...' — may contain paths/URLs; the whole span is one slot)
//   2. URLs          (contain slashes — must beat the path rule)
//   3. paths         (explicit markers only: / ~ ./ ../)
//   4. dates         (ISO-ish — must beat the number rule)
//   5. numbers       (standalone numeric tokens)
// Single-pass leftmost matching keeps slots in true occurrence order, which
// the replay slot-filler relies on.
const COMBINED_RE = /("[^"\n]+"|'[^'\n]+')|(https?:\/\/[^\s)"']+)|((?:^|(?<=\s))(?:~[\w./-]*|\.{1,2}\/[\w./-]*|\/[\w./-]+))|(\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b)|((?<![\w.])\d+(?:\.\d+)?(?![\w.]))/gi;

const GROUP_TYPES: SlotType[] = ['quoted', 'url', 'path', 'date', 'num'];

/**
 * Normalize a user message to its abstract form + the slots that were
 * lifted out, in occurrence order. Deterministic and total — no model
 * calls, no learning, so the same message always abstracts identically at
 * persist time and at match time.
 */
export function abstractMessage(message: string): { abstracted: string; slots: TypedSlot[] } {
    const slots: TypedSlot[] = [];
    // A message that already CONTAINS a literal placeholder token ("{path}")
    // must stay distinguishable from a message where a real entity was lifted
    // to that placeholder — same abstracted text would mean same signature
    // with a different slot count, which breaks positional slot-fill. Escape
    // pre-existing tokens to a marker the lifter never produces.
    const escaped = (message || '').replace(
        /\{(path|url|quoted|date|num)\}/gi,
        (_m, t: string) => `{{literal-${t.toLowerCase()}}}`,
    );
    const re = new RegExp(COMBINED_RE.source, COMBINED_RE.flags);
    const text = escaped.replace(re, (...args) => {
        const match = args[0] as string;
        const groups = args.slice(1, 6) as Array<string | undefined>;
        const idx = groups.findIndex(g => g !== undefined);
        const type = GROUP_TYPES[idx === -1 ? 0 : idx]!;
        slots.push({ type, placeholder: PLACEHOLDER[type], value: match });
        return PLACEHOLDER[type];
    });
    const abstracted = text.toLowerCase().replace(/\s+/g, ' ').trim();
    return { abstracted, slots };
}

/**
 * The abstracted task signature for a message. Byte-exact strictness on the
 * abstracted form is the feature — one recipe serves the whole parameter
 * family, and two requests that differ in any literal token never collide.
 *
 * `sig` is the SHA-256 of the FULL abstracted form (no truncation): a
 * readable prefix would leak normalized request text into persisted keys
 * and logs, and a truncated hash weakens the zero-false-positive bar.
 * `preview` is a short human-readable diagnostic for logs/UI — it must
 * NEVER participate in matching.
 */
export function computeAbstractSignature(message: string): { sig: string; preview: string; slots: TypedSlot[] } {
    const { abstracted, slots } = abstractMessage(message);
    const sig = createHash('sha256').update(abstracted, 'utf8').digest('hex');
    return { sig, preview: abstracted.slice(0, 80), slots };
}
