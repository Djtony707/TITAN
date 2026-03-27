/* ────────────────────────────────────────────────────────────────────────────
 * TITAN Model Benchmark — Configuration
 * ──────────────────────────────────────────────────────────────────────────── */

import type { Category, CostTier, ModelSpec } from './types.js';

/* ── Category weights (must sum to 1.0) ─────────────────────────────────── */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  reasoning:              0.20,
  code_generation:        0.20,
  math:                   0.15,
  tool_use:               0.15,
  instruction_following:  0.15,
  creative_writing:       0.08,
  summarization:          0.07,
};

/* ── Letter grade thresholds ────────────────────────────────────────────── */
export function letterGrade(score: number): import('./types.js').LetterGrade {
  if (score >= 9.5) return 'A+';
  if (score >= 9.0) return 'A';
  if (score >= 8.5) return 'A-';
  if (score >= 8.0) return 'B+';
  if (score >= 7.0) return 'B';
  if (score >= 6.5) return 'B-';
  if (score >= 6.0) return 'C+';
  if (score >= 5.0) return 'C';
  if (score >= 3.0) return 'D';
  return 'F';
}

/* ── Model roster ───────────────────────────────────────────────────────── */
function m(id: string, displayName: string, provider: string, paramsSize: string, contextWindow: string, costTier: CostTier): ModelSpec {
  return { id, displayName, provider, paramsSize, contextWindow, costTier };
}

export const MODEL_ROSTER: ModelSpec[] = [
  // ── Ollama Cloud models ──────────────────────────────────────────────
  m('ollama/minimax-m2.7:cloud',                                      'MiniMax M2.7',              'Ollama Cloud',  '2.3T',    '200K',  'free'),
  m('ollama/minimax-m2:cloud',                                        'MiniMax M2',                'Ollama Cloud',  'unknown', '128K',  'free'),
  m('ollama/glm-5:cloud',                                             'GLM-5',                     'Ollama Cloud',  '744B',    '128K',  'free'),
  m('ollama/glm-4.7:cloud',                                           'GLM-4.7',                   'Ollama Cloud',  'unknown', '128K',  'free'),
  m('ollama/deepseek-v3.2:cloud',                                     'DeepSeek V3.2',             'Ollama Cloud',  'unknown', '128K',  'free'),
  m('ollama/deepseek-v3.1:671b-cloud',                                'DeepSeek V3.1 671B',        'Ollama Cloud',  '671B',    '128K',  'free'),
  m('ollama/kimi-k2.5:cloud',                                         'Kimi K2.5',                 'Ollama Cloud',  '1T',      '128K',  'free'),
  m('ollama/qwen3-coder-next:cloud',                                  'Qwen3 Coder Next',          'Ollama Cloud',  'unknown', '256K',  'free'),
  m('ollama/nemotron-3-super:cloud',                                  'Nemotron 3 Super',          'Ollama Cloud',  '120B',    '128K',  'free'),
  m('ollama/qwen3.5:397b-cloud',                                      'Qwen 3.5 397B',             'Ollama Cloud',  '397B',    '128K',  'free'),
  m('ollama/gemini-3-flash-preview:latest',                            'Gemini 3 Flash Preview',    'Ollama Cloud',  'unknown', '1M',    'free'),

  // ── Ollama Local models (on RTX 5090) ────────────────────────────────
  m('ollama/qwen3.5:35b',                                             'Qwen 3.5 35B',              'Ollama Local',  '35B',     '32K',   'free'),
  m('ollama/nemotron-3-nano:latest',                                   'Nemotron 3 Nano 24B',       'Ollama Local',  '24B',     '128K',  'free'),
  m('ollama/nemotron-3-nano:4b',                                       'Nemotron 3 Nano 4B',        'Ollama Local',  '4B',      '128K',  'free'),
  m('ollama/devstral-small-2:latest',                                  'Devstral Small 2',          'Ollama Local',  '24B',     '128K',  'free'),
];

/* ── Default CLI options ────────────────────────────────────────────────── */
export const DEFAULTS = {
  gateway:  'http://192.168.1.11:48420',
  timeout:  60_000,
  delay:    500,
  output:   'benchmarks',
} as const;
