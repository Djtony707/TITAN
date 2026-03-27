/* ────────────────────────────────────────────────────────────────────────────
 * TITAN Model Benchmark — Type Definitions
 * ──────────────────────────────────────────────────────────────────────────── */

export type Category =
  | 'reasoning'
  | 'code_generation'
  | 'math'
  | 'tool_use'
  | 'instruction_following'
  | 'creative_writing'
  | 'summarization';

export type CostTier = 'free' | '$' | '$$' | '$$$';
export type LetterGrade = 'A+' | 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'D' | 'F';

export interface ModelSpec {
  id: string;              // "anthropic/claude-sonnet-4-20250514"
  displayName: string;     // "Claude Sonnet 4"
  provider: string;        // "anthropic"
  paramsSize: string;      // "~175B" or "unknown"
  contextWindow: string;   // "200K"
  costTier: CostTier;
}

export interface TestPrompt {
  id: string;                      // "reasoning-01"
  category: Category;
  prompt: string;
  expectedPatterns: RegExp[];      // Any match = partial credit
  requiredKeywords: string[];      // All must appear for full credit
  forbiddenPatterns?: RegExp[];    // Must NOT appear (penalty)
  maxScore: number;                // Typically 10
  toolExpected?: string;           // For tool_use: expected tool name
  evaluator: 'pattern' | 'code_check' | 'math_check' | 'instruction_check' | 'creative_check';
}

export interface TestResult {
  modelId: string;
  promptId: string;
  category: Category;
  response: string;
  score: number;           // 0–10
  latencyMs: number;
  tokenUsage?: { prompt: number; completion: number; total: number };
  toolsUsed?: string[];
  error?: string;
  timestamp: string;
}

export interface ModelScore {
  model: ModelSpec;
  categoryScores: Record<Category, number>;  // 0–10 average per category
  overallScore: number;                       // Weighted average
  avgLatencyMs: number;
  totalTokens: number;
  bestFor: string[];       // Tags: "code", "reasoning", "speed", etc.
  letterGrade: LetterGrade;
  results: TestResult[];
}

export interface BenchmarkRun {
  runId: string;
  timestamp: string;
  titanVersion: string;
  gatewayUrl: string;
  models: ModelScore[];
  totalDurationMs: number;
  promptCount: number;
  categoryCount: number;
}

export interface BenchmarkOptions {
  gateway: string;
  models?: string[];       // Filter: ["anthropic/*", "openai/gpt-4o"]
  categories?: Category[];
  timeout: number;         // Per-request ms
  dryRun: boolean;
  output: string;          // Output directory
  delay: number;           // Delay between requests (ms)
}
