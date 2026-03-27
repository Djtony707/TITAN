/* ────────────────────────────────────────────────────────────────────────────
 * TITAN Model Benchmark — Test Prompts
 * ──────────────────────────────────────────────────────────────────────────── */

import type { TestPrompt } from './types.js';

/* ── Reasoning (4) ──────────────────────────────────────────────────────── */
const reasoning: TestPrompt[] = [
  {
    id: 'reasoning-01',
    category: 'reasoning',
    prompt: 'A farmer has 17 sheep. All but 9 die. How many sheep does the farmer have left?',
    expectedPatterns: [/\b9\b/],
    requiredKeywords: ['9'],
    forbiddenPatterns: [/\b8\b/, /\b17\b.*left/i],
    maxScore: 10,
    evaluator: 'pattern',
  },
  {
    id: 'reasoning-02',
    category: 'reasoning',
    prompt: 'If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets?',
    expectedPatterns: [/5\s*minutes/i, /\bfive\s*minutes/i],
    requiredKeywords: ['5'],
    forbiddenPatterns: [/100\s*minutes/i, /\b500\b/],
    maxScore: 10,
    evaluator: 'pattern',
  },
  {
    id: 'reasoning-03',
    category: 'reasoning',
    prompt: 'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?',
    expectedPatterns: [/\$?0?\.05/, /5\s*cents/i, /\bfive\s*cents/i],
    requiredKeywords: [],
    forbiddenPatterns: [/\$?0?\.10\b(?!\s*more)/, /10\s*cents/i],
    maxScore: 10,
    evaluator: 'pattern',
  },
  {
    id: 'reasoning-04',
    category: 'reasoning',
    prompt: 'Three boxes are labeled "Apples", "Oranges", and "Mixed". All labels are wrong. You can pick one fruit from one box to determine the correct labels for all three boxes. Which box do you pick from, and how do you determine the correct labels?',
    expectedPatterns: [/mixed/i, /mislabel/i],
    requiredKeywords: ['mixed'],
    maxScore: 10,
    evaluator: 'pattern',
  },
];

/* ── Code Generation (4) ────────────────────────────────────────────────── */
const codeGeneration: TestPrompt[] = [
  {
    id: 'code-01',
    category: 'code_generation',
    prompt: 'Write a TypeScript function called `debounce` that takes a function and a delay in milliseconds, returns a debounced version. Include proper typing.',
    expectedPatterns: [/setTimeout/, /clearTimeout/, /=>/, /function|const/],
    requiredKeywords: ['debounce', 'setTimeout'],
    maxScore: 10,
    evaluator: 'code_check',
  },
  {
    id: 'code-02',
    category: 'code_generation',
    prompt: 'Write a Python function to find the longest common subsequence (LCS) of two strings using dynamic programming. Return the LCS string, not just its length.',
    expectedPatterns: [/def\s+\w+/, /dp|table|matrix/, /for\s+.*\s+in\s+range/],
    requiredKeywords: ['def', 'return'],
    maxScore: 10,
    evaluator: 'code_check',
  },
  {
    id: 'code-03',
    category: 'code_generation',
    prompt: 'Write a SQL query to find the second highest salary from an employees table. Handle the case where there might be duplicate salaries.',
    expectedPatterns: [/SELECT/i, /DISTINCT|DENSE_RANK|LIMIT|OFFSET|ROW_NUMBER/i],
    requiredKeywords: ['SELECT', 'salary'],
    maxScore: 10,
    evaluator: 'code_check',
  },
  {
    id: 'code-04',
    category: 'code_generation',
    prompt: 'Write a React component in TypeScript that implements an infinite scroll list. It should fetch data from `fetchItems(page: number)` and load more when the user scrolls near the bottom.',
    expectedPatterns: [/useEffect|useState/, /IntersectionObserver|scroll/i, /fetchItems/],
    requiredKeywords: ['useState', 'fetchItems'],
    maxScore: 10,
    evaluator: 'code_check',
  },
];

/* ── Math (4) ───────────────────────────────────────────────────────────── */
const math: TestPrompt[] = [
  {
    id: 'math-01',
    category: 'math',
    prompt: 'What is the derivative of f(x) = x^3 * ln(x)?',
    expectedPatterns: [/3x\^?2\s*[\*·]?\s*ln\s*\(?x\)?/i, /x\^?2/],
    requiredKeywords: ['ln', 'x'],
    maxScore: 10,
    evaluator: 'math_check',
  },
  {
    id: 'math-02',
    category: 'math',
    prompt: 'Solve the system of equations: 2x + 3y = 12, 4x - y = 5. Give exact values for x and y.',
    expectedPatterns: [/27\s*\/\s*14|1\.9(28)?/i, /23\s*\/\s*7|3\.2(85)?/i],
    requiredKeywords: ['x', 'y'],
    maxScore: 10,
    evaluator: 'math_check',
  },
  {
    id: 'math-03',
    category: 'math',
    prompt: 'A ball is thrown upward at 20 m/s from the ground. Using g = 10 m/s², what is the maximum height and total time in the air?',
    expectedPatterns: [/20\s*m(?:eters)?/i, /4\s*s(?:econds)?/i],
    requiredKeywords: ['20', '4'],
    maxScore: 10,
    evaluator: 'math_check',
  },
  {
    id: 'math-04',
    category: 'math',
    prompt: 'In how many ways can you distribute 10 identical balls into 4 distinct boxes?',
    expectedPatterns: [/286/, /C\s*\(\s*13\s*,\s*3\s*\)/],
    requiredKeywords: ['286'],
    maxScore: 10,
    evaluator: 'math_check',
  },
];

/* ── Tool Use (3) — runs through full agent pipeline ────────────────────── */
const toolUse: TestPrompt[] = [
  {
    id: 'tool-01',
    category: 'tool_use',
    prompt: 'What is the current date and time?',
    expectedPatterns: [/\d{1,2}:\d{2}/, /\d{4}/],
    requiredKeywords: [],
    maxScore: 10,
    toolExpected: 'system_info',
    evaluator: 'pattern',
  },
  {
    id: 'tool-02',
    category: 'tool_use',
    prompt: 'Search the web for "TITAN agent framework github" and tell me what you find.',
    expectedPatterns: [/github/i, /titan/i],
    requiredKeywords: [],
    maxScore: 10,
    toolExpected: 'web_search',
    evaluator: 'pattern',
  },
  {
    id: 'tool-03',
    category: 'tool_use',
    prompt: 'Run a shell command to list files in the current directory and show me the output.',
    expectedPatterns: [/\w+\.\w+/, /package\.json|src|node_modules/],
    requiredKeywords: [],
    maxScore: 10,
    toolExpected: 'shell',
    evaluator: 'pattern',
  },
];

/* ── Instruction Following (4) ──────────────────────────────────────────── */
const instructionFollowing: TestPrompt[] = [
  {
    id: 'instruct-01',
    category: 'instruction_following',
    prompt: 'List exactly 5 benefits of open source software. Number them 1-5. Keep each point under 15 words.',
    expectedPatterns: [/1\./m, /2\./m, /3\./m, /4\./m, /5\./m],
    requiredKeywords: [],
    forbiddenPatterns: [/6\./m],
    maxScore: 10,
    evaluator: 'instruction_check',
  },
  {
    id: 'instruct-02',
    category: 'instruction_following',
    prompt: 'Respond in exactly 3 sentences. Tell me about the history of the internet.',
    expectedPatterns: [/internet/i],
    requiredKeywords: [],
    maxScore: 10,
    evaluator: 'instruction_check',
  },
  {
    id: 'instruct-03',
    category: 'instruction_following',
    prompt: "Write the word 'hello' but replace every vowel with the number 7. Do not explain, just give the answer.",
    expectedPatterns: [/h7ll7/i],
    requiredKeywords: [],
    forbiddenPatterns: [/vowel/i, /replace/i, /explanation/i],
    maxScore: 10,
    evaluator: 'instruction_check',
  },
  {
    id: 'instruct-04',
    category: 'instruction_following',
    prompt: "Give me a JSON object with keys 'name', 'age', 'hobbies' (array of 3 strings). Only output valid JSON, no markdown code blocks.",
    expectedPatterns: [/"name"/, /"age"/, /"hobbies"/],
    requiredKeywords: [],
    forbiddenPatterns: [/```/],
    maxScore: 10,
    evaluator: 'instruction_check',
  },
];

/* ── Creative Writing (3) ───────────────────────────────────────────────── */
const creativeWriting: TestPrompt[] = [
  {
    id: 'creative-01',
    category: 'creative_writing',
    prompt: 'Write a haiku about programming. Follow the 5-7-5 syllable structure.',
    expectedPatterns: [/\n/, /code|bug|loop|function|program|debug|compile|syntax|script/i],
    requiredKeywords: [],
    maxScore: 10,
    evaluator: 'creative_check',
  },
  {
    id: 'creative-02',
    category: 'creative_writing',
    prompt: 'Write a 6-word story in the style of Hemingway. Only the 6 words, nothing else.',
    expectedPatterns: [/\w+/],
    requiredKeywords: [],
    maxScore: 10,
    evaluator: 'creative_check',
  },
  {
    id: 'creative-03',
    category: 'creative_writing',
    prompt: 'Explain quantum entanglement as if you were a pirate.',
    expectedPatterns: [/arr|matey|ship|treasure|sea|sail|captain|plunder|ye|ahoy/i],
    requiredKeywords: [],
    maxScore: 10,
    evaluator: 'creative_check',
  },
];

/* ── Summarization (3) ──────────────────────────────────────────────────── */
const CLIMATE_PASSAGE = `Climate change refers to long-term shifts in temperatures and weather patterns. Human activities have been the main driver of climate change, primarily due to the burning of fossil fuels like coal, oil, and gas, which produces heat-trapping gases. Global temperatures have risen about 1.1°C since the pre-industrial era. The effects include more frequent extreme weather events, rising sea levels, and disruptions to ecosystems. The Paris Agreement aims to limit warming to 1.5°C above pre-industrial levels. Renewable energy sources like solar and wind power are growing rapidly as alternatives to fossil fuels. Many countries have set net-zero emissions targets for 2050. However, current policies are insufficient to meet these goals, and more aggressive action is needed across all sectors of the economy.`;

const REST_PASSAGE = `REST (Representational State Transfer) is an architectural style for designing networked applications. It relies on a stateless, client-server communication protocol — typically HTTP. RESTful systems use standard HTTP methods: GET for retrieving resources, POST for creating new resources, PUT for updating existing resources, and DELETE for removing resources. Each resource is identified by a unique URI (Uniform Resource Identifier). REST APIs typically use JSON as the data interchange format, though XML is also supported. Authentication is commonly handled through OAuth 2.0 tokens or API keys passed in request headers. Rate limiting prevents abuse by restricting the number of requests a client can make within a time window. Pagination helps manage large datasets by returning results in smaller chunks. HATEOAS (Hypermedia as the Engine of Application State) is an advanced REST constraint where the server provides links to related resources in its responses.`;

const DEBATE_PASSAGE = `Remote work has fundamentally changed the modern workplace. Proponents argue that it increases productivity by eliminating commute time, provides better work-life balance, and allows companies to hire talent from anywhere in the world. Studies from Stanford show a 13% performance increase among remote workers. However, critics point out that remote work can lead to isolation, difficulty in collaboration, and blurred boundaries between work and personal life. A Gallup survey found that 25% of remote workers reported feeling lonely. Companies like Amazon and Goldman Sachs have mandated return-to-office policies, citing concerns about culture and innovation. Meanwhile, companies like Shopify and Automattic remain fully remote and report strong results. The debate often comes down to the nature of the work — creative collaboration may benefit from in-person interaction, while focused individual work may be better suited to remote environments.`;

const summarization: TestPrompt[] = [
  {
    id: 'summary-01',
    category: 'summarization',
    prompt: `Summarize the following passage in exactly 2 sentences:\n\n${CLIMATE_PASSAGE}`,
    expectedPatterns: [/climate|temperature|warming/i, /emission|fossil|renewable/i],
    requiredKeywords: [],
    maxScore: 10,
    evaluator: 'instruction_check',
  },
  {
    id: 'summary-02',
    category: 'summarization',
    prompt: `Summarize the following technical passage in 3-4 bullet points for a non-technical audience. Avoid jargon:\n\n${REST_PASSAGE}`,
    expectedPatterns: [/[-•*]\s/, /request|send|receiv|communicat/i],
    requiredKeywords: [],
    forbiddenPatterns: [/\bURI\b/, /\bHATEOAS\b/, /\bOAuth\b/],
    maxScore: 10,
    evaluator: 'instruction_check',
  },
  {
    id: 'summary-03',
    category: 'summarization',
    prompt: `Summarize the following passage in a balanced way, presenting both sides fairly:\n\n${DEBATE_PASSAGE}`,
    expectedPatterns: [/productiv|balance|flexibility/i, /isolat|collaborat|lonely|culture/i],
    requiredKeywords: [],
    maxScore: 10,
    evaluator: 'pattern',
  },
];

/* ── Export all prompts ─────────────────────────────────────────────────── */
export const ALL_PROMPTS: TestPrompt[] = [
  ...reasoning,
  ...codeGeneration,
  ...math,
  ...toolUse,
  ...instructionFollowing,
  ...creativeWriting,
  ...summarization,
];

export const PROMPTS_BY_CATEGORY: Record<string, TestPrompt[]> = {
  reasoning,
  code_generation: codeGeneration,
  math,
  tool_use: toolUse,
  instruction_following: instructionFollowing,
  creative_writing: creativeWriting,
  summarization,
};
