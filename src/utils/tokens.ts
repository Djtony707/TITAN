/**
 * Fast token estimation without heavy dependencies.
 * 
 * GPT/claude-style tokenizers:
 * - English prose: ~3.5-4 chars per token
 * - Code / symbols: ~1.5-2.5 chars per token  
 * - Mixed content: ~2.5-3 chars per token
 * 
 * The old `text.length / 4` undercounts code by 30-50%.
 * We use a blended estimate that weights symbol density higher.
 */
export function estimateTokens(text: string): number {
    if (!text || text.length === 0) return 0;

    const len = text.length;
    // Symbol-heavy text (code, markdown, JSON) tokenizes at ~2 chars/token
    const symbolDensity =
        (text.match(/[{}();:=<>[\]/\\|&!?@#$%~^*+\-`"']/g) || []).length / len;

    // Base divisor: 4 for prose, down to 2.5 for code-heavy text
    const divisor = symbolDensity > 0.08 ? 2.5 : symbolDensity > 0.03 ? 3.0 : 3.8;

    return Math.ceil(len / divisor);
}

/** Estimate tokens for an array of messages (summing content fields). */
export function estimateMessageTokens(messages: { content?: unknown }[]): number {
    return messages.reduce((sum, m) => {
        const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return sum + estimateTokens(text);
    }, 0);
}
