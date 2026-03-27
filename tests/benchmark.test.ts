/* ────────────────────────────────────────────────────────────────────────────
 * TITAN Model Benchmark — Unit Tests
 *
 * Tests the benchmark infrastructure (evaluator, config, prompts)
 * without making any live API calls.
 * ──────────────────────────────────────────────────────────────────────────── */

import { describe, it, expect } from 'vitest';
import { evaluate } from '../scripts/benchmark/evaluator.js';
import { ALL_PROMPTS, PROMPTS_BY_CATEGORY } from '../scripts/benchmark/prompts.js';
import { MODEL_ROSTER, CATEGORY_WEIGHTS, letterGrade } from '../scripts/benchmark/config.js';
import type { TestPrompt, Category } from '../scripts/benchmark/types.js';

/* ── Prompt validation ──────────────────────────────────────────────────── */
describe('Benchmark prompts', () => {
  it('should have 25 total prompts', () => {
    expect(ALL_PROMPTS.length).toBe(25);
  });

  it('should have unique IDs', () => {
    const ids = ALL_PROMPTS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should cover all 7 categories', () => {
    const categories = new Set(ALL_PROMPTS.map(p => p.category));
    expect(categories.size).toBe(7);
    expect(categories).toContain('reasoning');
    expect(categories).toContain('code_generation');
    expect(categories).toContain('math');
    expect(categories).toContain('tool_use');
    expect(categories).toContain('instruction_following');
    expect(categories).toContain('creative_writing');
    expect(categories).toContain('summarization');
  });

  it('should have valid structure for each prompt', () => {
    for (const p of ALL_PROMPTS) {
      expect(p.id).toBeTruthy();
      expect(p.category).toBeTruthy();
      expect(p.prompt).toBeTruthy();
      expect(p.prompt.length).toBeGreaterThan(10);
      expect(p.maxScore).toBe(10);
      expect(p.expectedPatterns).toBeInstanceOf(Array);
      expect(p.requiredKeywords).toBeInstanceOf(Array);
      expect(['pattern', 'code_check', 'math_check', 'instruction_check', 'creative_check']).toContain(p.evaluator);
    }
  });

  it('should have prompts by category matching ALL_PROMPTS', () => {
    let total = 0;
    for (const [, prompts] of Object.entries(PROMPTS_BY_CATEGORY)) {
      total += prompts.length;
    }
    expect(total).toBe(ALL_PROMPTS.length);
  });
});

/* ── Config validation ──────────────────────────────────────────────────── */
describe('Benchmark config', () => {
  it('should have 15 models in roster', () => {
    expect(MODEL_ROSTER.length).toBe(15);
  });

  it('should have unique model IDs', () => {
    const ids = MODEL_ROSTER.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should have category weights summing to ~1.0', () => {
    const sum = Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 2);
  });

  it('should have weights for all 7 categories', () => {
    expect(Object.keys(CATEGORY_WEIGHTS).length).toBe(7);
  });
});

/* ── Letter grades ──────────────────────────────────────────────────────── */
describe('Letter grades', () => {
  it('should assign A+ for 9.5+', () => {
    expect(letterGrade(10)).toBe('A+');
    expect(letterGrade(9.5)).toBe('A+');
  });

  it('should assign A for 9.0-9.4', () => {
    expect(letterGrade(9.2)).toBe('A');
  });

  it('should assign F for 0-2.9', () => {
    expect(letterGrade(0)).toBe('F');
    expect(letterGrade(2)).toBe('F');
  });

  it('should cover the full range', () => {
    expect(letterGrade(8.5)).toBe('A-');
    expect(letterGrade(8.0)).toBe('B+');
    expect(letterGrade(7.5)).toBe('B');
    expect(letterGrade(6.5)).toBe('B-');
    expect(letterGrade(6.0)).toBe('C+');
    expect(letterGrade(5.5)).toBe('C');
    expect(letterGrade(4.0)).toBe('D');
  });
});

/* ── Evaluator ──────────────────────────────────────────────────────────── */
describe('Evaluator', () => {
  const makePrompt = (overrides: Partial<TestPrompt> = {}): TestPrompt => ({
    id: 'test-01',
    category: 'reasoning',
    prompt: 'test prompt',
    expectedPatterns: [/\b9\b/],
    requiredKeywords: ['nine'],
    maxScore: 10,
    evaluator: 'pattern',
    ...overrides,
  });

  it('should return 0 for empty response', () => {
    expect(evaluate('', makePrompt())).toBe(0);
    expect(evaluate('   ', makePrompt())).toBe(0);
  });

  it('should score higher when patterns and keywords match', () => {
    const prompt = makePrompt();
    const good = evaluate('The answer is 9, nine sheep remain.', prompt);
    const bad = evaluate('I have no idea what the answer is.', prompt);
    expect(good).toBeGreaterThan(bad);
  });

  it('should apply forbidden pattern penalties', () => {
    const prompt = makePrompt({
      forbiddenPatterns: [/wrong/i],
    });
    const withForbidden = evaluate('The answer is 9, nine, but this is wrong.', prompt);
    const withoutForbidden = evaluate('The answer is 9, nine sheep.', prompt);
    expect(withoutForbidden).toBeGreaterThan(withForbidden);
  });

  it('should never exceed maxScore', () => {
    const prompt = makePrompt({ maxScore: 10 });
    const score = evaluate('nine 9 nine 9 nine 9 nine 9 and more text to get bonus points for being long enough', prompt);
    expect(score).toBeLessThanOrEqual(10);
  });

  it('should never go below 0', () => {
    const prompt = makePrompt({
      forbiddenPatterns: [/a/i, /e/i, /i/i, /o/i, /u/i],
      expectedPatterns: [/xyz_impossible/],
      requiredKeywords: ['impossible_keyword'],
    });
    const score = evaluate('This has all vowels a e i o u.', prompt);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  // Code evaluator
  it('should give code bonuses for well-formatted code', () => {
    const prompt = makePrompt({
      evaluator: 'code_check',
      expectedPatterns: [/function/],
      requiredKeywords: ['function'],
    });
    const good = evaluate('```typescript\nfunction debounce(fn: Function, delay: number): Function {\n  // implementation\n  let timer: number;\n  return () => {};\n}\n```', prompt);
    const bad = evaluate('function x', prompt);
    expect(good).toBeGreaterThan(bad);
  });

  // Math evaluator
  it('should give math bonuses for step-by-step reasoning', () => {
    const prompt = makePrompt({
      evaluator: 'math_check',
      expectedPatterns: [/\b9\b/],
      requiredKeywords: ['9'],
    });
    const detailed = evaluate('Step 1: First we calculate. Step 2: Then we substitute. Therefore the answer is 9. nine = 9.', prompt);
    const terse = evaluate('9', prompt);
    expect(detailed).toBeGreaterThan(terse);
  });

  // Instruction check
  it('should validate JSON output in instruction_check', () => {
    const prompt = makePrompt({
      evaluator: 'instruction_check',
      prompt: 'Give me a JSON object with keys',
      expectedPatterns: [/"name"/],
      requiredKeywords: [],
    });
    const valid = evaluate('{"name": "Tony", "age": 30, "hobbies": ["music", "code", "AI"]}', prompt);
    const invalid = evaluate('{name: Tony, broken json', prompt);
    expect(valid).toBeGreaterThan(invalid);
  });

  // Creative check
  it('should validate haiku structure in creative_check', () => {
    const prompt = makePrompt({
      evaluator: 'creative_check',
      prompt: 'Write a haiku about programming',
      expectedPatterns: [/code|bug|loop/i],
      requiredKeywords: [],
    });
    const haiku = evaluate('Silent code runs deep\nBugs emerge from shadowed lines\nDebug light shines through', prompt);
    const notHaiku = evaluate('Code is great and bugs are bad.', prompt);
    expect(haiku).toBeGreaterThan(notHaiku);
  });

  // Reasoning: classic trick questions
  it('should score correctly on the sheep question', () => {
    const prompt = ALL_PROMPTS.find(p => p.id === 'reasoning-01')!;
    const correct = evaluate('The farmer has 9 sheep left.', prompt);
    const wrong = evaluate('The farmer has 8 sheep left because 17 minus 9 is 8.', prompt);
    expect(correct).toBeGreaterThan(wrong);
  });

  it('should score correctly on the bat and ball question', () => {
    const prompt = ALL_PROMPTS.find(p => p.id === 'reasoning-03')!;
    const correct = evaluate('The ball costs $0.05 (5 cents).', prompt);
    const wrong = evaluate('The ball costs $0.10 (10 cents).', prompt);
    expect(correct).toBeGreaterThan(wrong);
  });
});
