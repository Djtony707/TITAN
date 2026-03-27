/* ────────────────────────────────────────────────────────────────────────────
 * TITAN Model Benchmark — Response Evaluator
 * ──────────────────────────────────────────────────────────────────────────── */

import type { TestPrompt } from './types.js';

/**
 * Score a model response against a test prompt.
 * Returns a score between 0 and maxScore (typically 10).
 */
export function evaluate(response: string, prompt: TestPrompt): number {
  if (!response || response.trim().length === 0) return 0;

  const lower = response.toLowerCase();
  let score = 0;

  // ── Base: pattern matching (0–4) ──────────────────────────────────────
  const patternHits = prompt.expectedPatterns.filter(p => p.test(response)).length;
  const patternRatio = prompt.expectedPatterns.length > 0
    ? patternHits / prompt.expectedPatterns.length
    : 0;
  score += patternRatio * 4;

  // ── Required keywords (0–3) ───────────────────────────────────────────
  if (prompt.requiredKeywords.length > 0) {
    const kwHits = prompt.requiredKeywords.filter(kw => lower.includes(kw.toLowerCase())).length;
    score += (kwHits / prompt.requiredKeywords.length) * 3;
  } else {
    // No keywords required — give full marks if patterns hit
    score += patternRatio > 0 ? 3 : 0;
  }

  // ── Forbidden patterns (penalty: –2 each, min 0) ─────────────────────
  if (prompt.forbiddenPatterns) {
    for (const fp of prompt.forbiddenPatterns) {
      if (fp.test(response)) score -= 2;
    }
  }

  // ── Category-specific bonuses (0–3) ───────────────────────────────────
  switch (prompt.evaluator) {
    case 'code_check':
      score += evaluateCode(response);
      break;
    case 'math_check':
      score += evaluateMath(response, prompt);
      break;
    case 'instruction_check':
      score += evaluateInstruction(response, prompt);
      break;
    case 'creative_check':
      score += evaluateCreative(response, prompt);
      break;
    case 'pattern':
    default:
      // Pattern-only: bonus for substantive response
      if (response.trim().length > 50) score += 1;
      if (response.trim().length > 200) score += 1;
      if (patternRatio >= 0.75) score += 1;
      break;
  }

  // Clamp to [0, maxScore]
  return Math.max(0, Math.min(prompt.maxScore, Math.round(score * 10) / 10));
}

/* ── Code quality heuristics ────────────────────────────────────────────── */
function evaluateCode(response: string): number {
  let bonus = 0;

  // Contains a code block
  if (/```[\s\S]+```/.test(response) || /^\s*(function|const|def|class|SELECT)\b/m.test(response)) {
    bonus += 1;
  }

  // Has proper formatting (indentation)
  if (/\n\s{2,}\S/.test(response)) bonus += 0.5;

  // Has type annotations (TypeScript/Python hints)
  if (/:\s*(string|number|boolean|void|int|str|list|Promise|React)/i.test(response)) bonus += 0.5;

  // Includes comments or explanations
  if (/\/\/|#\s|\/\*|\*\//.test(response)) bonus += 0.5;

  // Reasonable length (not too short, not absurdly long)
  const lines = response.split('\n').length;
  if (lines >= 5 && lines <= 100) bonus += 0.5;

  return Math.min(3, bonus);
}

/* ── Math correctness heuristics ────────────────────────────────────────── */
function evaluateMath(response: string, prompt: TestPrompt): number {
  let bonus = 0;

  // Shows work/reasoning
  if (response.length > 100) bonus += 0.5;

  // Contains equations or mathematical notation
  if (/[=+\-*/^]/.test(response) && /\d/.test(response)) bonus += 0.5;

  // Step-by-step reasoning
  const stepIndicators = (response.match(/step|first|then|therefore|thus|so we|substitut/gi) || []).length;
  if (stepIndicators >= 2) bonus += 1;

  // All expected patterns match (exact answer)
  const allMatch = prompt.expectedPatterns.every(p => p.test(response));
  if (allMatch) bonus += 1;

  return Math.min(3, bonus);
}

/* ── Instruction compliance heuristics ──────────────────────────────────── */
function evaluateInstruction(response: string, prompt: TestPrompt): number {
  let bonus = 0;
  const promptLower = prompt.prompt.toLowerCase();

  // "exactly N sentences" check
  const sentenceCountMatch = promptLower.match(/exactly\s+(\d+)\s+sentence/);
  if (sentenceCountMatch) {
    const expected = parseInt(sentenceCountMatch[1], 10);
    const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 5).length;
    if (sentences === expected) bonus += 2;
    else if (Math.abs(sentences - expected) <= 1) bonus += 1;
  }

  // "exactly N" items (numbered list) check
  const itemCountMatch = promptLower.match(/exactly\s+(\d+)\s+(?:benefits|items|points|reasons)/);
  if (itemCountMatch) {
    const expected = parseInt(itemCountMatch[1], 10);
    const numberedItems = (response.match(/^\s*\d+[.)]\s/gm) || []).length;
    if (numberedItems === expected) bonus += 2;
    else if (Math.abs(numberedItems - expected) <= 1) bonus += 1;
  }

  // JSON validity check
  if (promptLower.includes('json')) {
    try {
      // Try to extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        JSON.parse(jsonMatch[0]);
        bonus += 2;
      }
    } catch {
      // Invalid JSON
    }
  }

  // Bullet points check
  if (promptLower.includes('bullet') || promptLower.includes('point')) {
    const bullets = (response.match(/^[\s]*[-•*]\s/gm) || []).length;
    if (bullets >= 3) bonus += 1;
  }

  // Conciseness (no excessive explanation when told "just give the answer")
  if (promptLower.includes('just give') || promptLower.includes('do not explain')) {
    if (response.trim().split(/\s+/).length <= 10) bonus += 1;
  }

  return Math.min(3, bonus);
}

/* ── Creative writing heuristics ────────────────────────────────────────── */
function evaluateCreative(response: string, prompt: TestPrompt): number {
  let bonus = 0;
  const promptLower = prompt.prompt.toLowerCase();

  // Haiku: 3 lines
  if (promptLower.includes('haiku')) {
    const lines = response.trim().split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 3) bonus += 2;
    else if (lines.length >= 2 && lines.length <= 4) bonus += 1;
  }

  // 6-word story: ~6 words
  if (promptLower.includes('6-word') || promptLower.includes('six-word')) {
    const words = response.trim().split(/\s+/).length;
    if (words >= 5 && words <= 8) bonus += 2;
    else if (words <= 12) bonus += 1;
  }

  // Persona: vocabulary richness (pirate, etc.)
  if (promptLower.includes('pirate')) {
    const pirateWords = (response.match(/\b(arr|matey|ship|treasure|sea|sail|captain|ahoy|ye|plunder|booty|scallywag|bucko|aye)\b/gi) || []).length;
    if (pirateWords >= 3) bonus += 2;
    else if (pirateWords >= 1) bonus += 1;

    // Also mentions the actual topic
    if (/entangle|quantum|particle|state|spin/i.test(response)) bonus += 1;
  }

  return Math.min(3, bonus);
}
