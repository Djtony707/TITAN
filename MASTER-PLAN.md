# TITAN Master Plan — Complete Remediation

**Version**: 5.4.1 → 6.0.0  
**Goal**: Every README claim is honest, every harness gap is closed, every test passes, and 5 specialist agents run 24/7 autonomously.  
**Estimated Duration**: 14–18 days of focused work  
**Team**: You + 5 TITAN specialist agents (Builder, Tester, Docs, Reviewer, DevOps)

---

## Table of Contents

1. [Phase 0: Foundation (Day 1)](#phase-0-foundation-day-1)
2. [Phase 1: Critical Path (Days 2–3)](#phase-1-critical-path-days-2-3)
3. [Phase 2: Core Refactor (Days 4–7)](#phase-2-core-refactor-days-4-7)
4. [Phase 3: Feature Verification (Days 8–10)](#phase-3-feature-verification-days-8-10)
5. [Phase 4: Testing & Hardening (Days 11–13)](#phase-4-testing--hardening-days-11-13)
6. [Phase 5: Multi-Agent Worker Swarm (Days 14–16)](#phase-5-multi-agent-worker-swarm-days-14-16)
7. [Phase 6: Documentation & Ship (Days 17–18)](#phase-6-documentation--ship-days-17-18)

---

## Phase 0: Foundation (Day 1)

**Goal**: The codebase compiles, installs, and produces an honest test baseline.

### 0.1 — Install Dependencies

```bash
cd ~/Desktop/TitanBot/TITAN-main
npm install
```

**Expected issues to watch for**:
- Native module compilation failures (bcrypt, sqlite3, etc.)
- Peer dependency conflicts (use `--legacy-peer-deps` if needed)
- Platform-specific packages failing on macOS ARM64

**If install fails**:
```bash
npm install --legacy-peer-deps
# or
npm install --force
```

**Verify**:
```bash
ls node_modules/.package-lock.json
ls node_modules/vitest
ls node_modules/tsup
```

### 0.2 — Type Check

```bash
npm run typecheck
```

**What to do with errors**:
1. Categorize them: `import` errors, `type` errors, `missing property` errors
2. Fix `import` errors first (usually path aliases or missing `.js` extensions in ESM)
3. Fix `type` errors second (usually interface drift between modules)
4. Ignore `any` warnings for now — we'll clean those in Phase 2

**Create a baseline log**:
```bash
npm run typecheck 2>&1 | tee typecheck-baseline.log
```

### 0.3 — Build

```bash
npm run build
```

**Expected output**:
- `dist/cli/index.js` created
- `dist/agent/` directory created
- No tsup errors

**If UI build is separate**:
```bash
npm run build:ui
```

### 0.4 — Run Unit + Mock Tests

```bash
npm test
npm run test:parity
```

**Capture baseline**:
```bash
npm test 2>&1 | tee test-baseline.log
```

**Document**:
- Total tests run
- Pass count
- Fail count
- Duration
- Any suites that timeout or OOM

### 0.5 — Run README Claim Verification

```bash
npm test -- tests/unit/readme-claims.test.ts
```

**This is the truth-teller test**. It will tell us:
- Actual tool count at runtime
- Actual widget template count
- Whether any README claims are lies

**If it fails**, document each drift item and add it to the fix list.

### 0.6 — Create `.env.local`

```bash
cp .env.example .env.local
```

**Fill in minimum required vars**:
```
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
# or
OLLAMA_HOST=http://localhost:11434
```

**Deliverable**: `npm test` exits 0. We have an honest baseline in `test-baseline.log`.

---

## Phase 1: Critical Path (Days 2–3)

**Goal**: Unblock 24/7 multi-agent operation and fix the #1 architectural anti-pattern.

### 1.1 — Enable Heartbeat Inbox (P0)

**File**: `src/agent/agentLoop.ts`  
**Lines**: ~178–194 (search for `checkAndProcessInbox`)

**Current state**:
```typescript
// if (ctx.agentId && round > 0 && round % 3 === 0) {
//     await checkAndProcessInbox(ctx.agentId);
// }
```

**Fix**:
```typescript
const HEARTBEAT_INBOX_ENABLED = process.env.TITAN_HEARTBEAT_INBOX === 'true';

if (HEARTBEAT_INBOX_ENABLED && ctx.agentId && round > 0 && round % 3 === 0) {
    await checkAndProcessInbox(ctx.agentId);
}
```

**Also uncomment** (line ~191–194):
```typescript
const cpEnabled = config.commandPost?.enabled ?? false;
if (HEARTBEAT_INBOX_ENABLED && cpEnabled && ctx.agentId && round === 0) {
    await checkAndProcessInbox(ctx.agentId);
}
```

**Add to `.env.local`**:
```
TITAN_HEARTBEAT_INBOX=true
```

**Verify the function exists**:
```bash
grep -n "function checkAndProcessInbox" src/agent/agentLoop.ts
```

**If it doesn't exist**, create it:
```typescript
// src/agent/agentLoop.ts — inside the module

async function checkAndProcessInbox(agentId: string): Promise<void> {
    const inbox = getAgentInbox(agentId);
    if (inbox.length === 0) return;

    const req = inbox[0];
    const claimed = claimWakeupRequest(req.id);
    if (!claimed) return;

    updateIssue(req.issueId, { status: 'in_progress' });
    const run = startRun(agentId, 'assignment', req.issueId);

    try {
        const result = await spawnSubAgent({
            name: req.agentName,
            task: req.task,
            tools: req.tools ?? ['read', 'write', 'edit', 'bash'],
            model: req.model,
        });

        endRun(run.id, { status: result.success ? 'succeeded' : 'failed' });
        addIssueComment(req.issueId, `**Result**: ${result.content}`);
        updateIssue(req.issueId, { status: result.success ? 'done' : 'todo' });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        releaseWakeupRequest(req.id, message);
        endRun(run.id, { status: 'failed' });
        addIssueComment(req.issueId, `**Error**: ${message}`);
        updateIssue(req.issueId, { status: 'failed' });
    }
}
```

**Verify imports**:
Make sure `getAgentInbox`, `claimWakeupRequest`, `releaseWakeupRequest`, `updateIssue`, `startRun`, `endRun`, `addIssueComment`, `spawnSubAgent` are imported at the top of `agentLoop.ts`.

**Test**:
```bash
npm test -- tests/agent-wakeup.test.ts
npm test -- tests/agent-loop.test.ts
```

**Add harness test**: `tests/harness/heartbeat-inbox.test.ts`
```typescript
import { describe, it, expect, vi } from 'vitest';
import { checkAndProcessInbox } from '../../src/agent/agentLoop.js';
import { queueWakeup, getAgentInbox, claimWakeupRequest } from '../../src/agent/agentWakeup.js';

describe('heartbeat inbox', () => {
    it('claims and processes a queued wakeup request', async () => {
        const agentId = 'test-agent';
        queueWakeup({ agentId, task: 'echo hello', issueId: 'TIT-001' });
        
        await checkAndProcessInbox(agentId);
        
        const inbox = getAgentInbox(agentId);
        expect(inbox[0].status).toBe('running');
    });

    it('does not double-claim a request', async () => {
        const agentId = 'test-agent-2';
        queueWakeup({ agentId, task: 'sleep 1', issueId: 'TIT-002' });
        
        const first = claimWakeupRequest(getAgentInbox(agentId)[0].id);
        const second = claimWakeupRequest(getAgentInbox(agentId)[0].id);
        
        expect(first).not.toBeNull();
        expect(second).toBeNull();
    });
});
```

### 1.2 — Reduce 253 Tools to 5 Primitives (P0)

**This is the hardest and most important refactor.**

**Current state**: 253 tools registered at runtime. Every tool definition consumes ~120 tokens. Total: ~30,000 tokens before any conversation.

**Target state**: 5 primitive tools that never change mid-session. All other capabilities become skills (prompt templates + subagent configs).

#### Step 1: Define the 5 Primitives

Create `src/agent/primitiveTools.ts`:

```typescript
/**
 * TITAN Primitive Tools — The only tools the model sees directly.
 * Everything else is a skill implemented via these primitives.
 */

export const PRIMITIVE_TOOLS = [
    {
        name: 'read',
        description: 'Read a file, URL, or artifact handle. Returns content or an error.',
        parameters: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    description: 'File path, URL, or artifact://handle'
                },
                offset: { type: 'number', description: 'Line offset for partial reads' },
                limit: { type: 'number', description: 'Max lines to read' }
            },
            required: ['target']
        }
    },
    {
        name: 'write',
        description: 'Write content to a file or artifact. Creates if missing, overwrites if exists.',
        parameters: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'File path or artifact://handle' },
                content: { type: 'string', description: 'Content to write' }
            },
            required: ['target', 'content']
        }
    },
    {
        name: 'edit',
        description: 'Edit a file using search/replace. Fails if search string not found exactly once.',
        parameters: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'File path' },
                search: { type: 'string', description: 'Exact string to find' },
                replace: { type: 'string', description: 'Replacement string' }
            },
            required: ['target', 'search', 'replace']
        }
    },
    {
        name: 'bash',
        description: 'Execute a shell command in a sandboxed environment. Returns stdout/stderr.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to run' },
                cwd: { type: 'string', description: 'Working directory' },
                timeout: { type: 'number', description: 'Timeout in ms (default 30000)' }
            },
            required: ['command']
        }
    },
    {
        name: 'delegate',
        description: 'Delegate a task to a subagent or external adapter. Returns result when complete.',
        parameters: {
            type: 'object',
            properties: {
                task: { type: 'string', description: 'Task description' },
                to: {
                    type: 'string',
                    description: 'Agent name, skill name, or adapter (claude-code, codex, bash)'
                },
                context: { type: 'string', description: 'Additional context for the delegate' }
            },
            required: ['task', 'to']
        }
    }
] as const;
```

#### Step 2: Add Skill Search Tool

Create `src/skills/searchSkills.ts`:

```typescript
import { getSkills } from './registry.js';

export function searchSkillsTool() {
    return {
        name: 'search_skills',
        description: 'Search the skill registry for capabilities relevant to the current task. Returns skill names and descriptions.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What you need to do (e.g., "send email", "query database")' }
            },
            required: ['query']
        },
        execute: async ({ query }: { query: string }) => {
            const skills = getSkills();
            const matches = skills
                .filter(s => 
                    s.name.includes(query) ||
                    s.description?.includes(query) ||
                    s.tags?.some((t: string) => t.includes(query))
                )
                .map(s => ({ name: s.name, description: s.description }))
                .slice(0, 10);
            return JSON.stringify(matches, null, 2);
        }
    };
}
```

#### Step 3: Refactor Tool Registration

**File**: `src/skills/registry.ts`

Find the function that registers all tools. Replace the dynamic tool loading with:

```typescript
import { PRIMITIVE_TOOLS } from '../agent/primitiveTools.js';
import { searchSkillsTool } from './searchSkills.js';

export function getPrimitiveTools() {
    return [...PRIMITIVE_TOOLS, searchSkillsTool()];
}
```

**File**: `src/agent/agent.ts` or wherever the tool catalog is assembled

Change tool assembly to:

```typescript
const tools = getPrimitiveTools();
// Skills are loaded into context as guidance, not as callable tools
const skillGuidance = getSkills()
    .filter(s => s.relevantToCurrentTask)
    .map(s => `- ${s.name}: ${s.description}`)
    .join('\n');
```

**File**: `src/agent/systemPromptParts.ts`

Add to the system prompt:

```typescript
export const SKILL_GUIDANCE_BLOCK = (skills: string[]) => `## Available Skills
If the primitives are insufficient, search for a skill:
<tool_call>search_skills({"query": "what you need"})</tool_call>

Relevant skills for this task:
${skills.join('\n')}`;
```

#### Step 4: Convert Existing Tools to Skills

For each of the 248 non-primitive tools, create a skill file:

```
~/.titan/workspace/skills/auto-{toolName}/SKILL.md
```

Example for `send_email`:

```markdown
# send_email
Send an email via SMTP or API.

## When to use
When the user asks to send an email, newsletter, or notification.

## How to use
1. Use `bash` to call the email API or SMTP client
2. Use `write` to draft the email content if needed
3. Use `read` to verify the email was queued

## Example
<tool_call>bash({"command": "curl -X POST https://api.sendgrid.com/v3/mail/send -H \"Authorization: Bearer $SENDGRID_KEY\" -d '{\"to\":\"user@example.com\",\"subject\":\"Hello\",\"text\":\"World\"}'"})</tool_call>
```

**Script to auto-generate**:
```bash
node scripts/convert-tools-to-skills.cjs
```

Create `scripts/convert-tools-to-skills.cjs`:
```javascript
const fs = require('fs');
const path = require('path');

const skillsDir = path.join(require('os').homedir(), '.titan', 'workspace', 'skills');
const tools = require('../dist/skills/registry.js').getAllTools(); // adjust path

for (const tool of tools) {
    if (['read', 'write', 'edit', 'bash', 'delegate'].includes(tool.name)) continue;
    
    const dir = path.join(skillsDir, `auto-${tool.name}`);
    fs.mkdirSync(dir, { recursive: true });
    
    const md = `# ${tool.name}
${tool.description}

## When to use
Add heuristics here based on tool usage patterns.

## How to use
Describe which primitives to compose to achieve this goal.
`;
    
    fs.writeFileSync(path.join(dir, 'SKILL.md'), md);
}
```

#### Step 5: Update Tests

**File**: `tests/unit/readme-claims.test.ts`

Change the tool count assertion:
```typescript
// OLD:
expect(toolCount).toBeGreaterThanOrEqual(248);

// NEW:
expect(toolCount).toBe(6); // 5 primitives + search_skills
```

**Deliverable**: `npm test` passes with 6 tools. All other capabilities work via skills.

---

## Phase 2: Core Refactor (Days 4–7)

**Goal**: Decompose the monolith, add artifact store, fix dynamic injection.

### 2.1 — Artifact Store (Day 4)

**File**: `src/agent/artifactStore.ts` (new)

```typescript
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

const ARTIFACT_DIR = join(tmpdir(), 'titan-artifacts');
mkdirSync(ARTIFACT_DIR, { recursive: true });

export function createArtifact(content: string, extension = 'txt'): string {
    const id = randomBytes(8).toString('hex');
    const handle = `artifact://${id}.${extension}`;
    const path = join(ARTIFACT_DIR, `${id}.${extension}`);
    writeFileSync(path, content);
    return handle;
}

export function readArtifact(handle: string): string {
    const id = handle.replace('artifact://', '');
    const path = join(ARTIFACT_DIR, id);
    if (!existsSync(path)) throw new Error(`Artifact not found: ${handle}`);
    return readFileSync(path, 'utf-8');
}

export function artifactExists(handle: string): boolean {
    const id = handle.replace('artifact://', '');
    return existsSync(join(ARTIFACT_DIR, id));
}
```

**File**: `src/agent/toolRunner.ts`

Add artifactization logic:
```typescript
import { createArtifact } from './artifactStore.js';

const ARTIFACT_THRESHOLD = 1000; // tokens

function maybeArtifactize(result: string): string {
    if (estimateTokens(result) > ARTIFACT_THRESHOLD) {
        return createArtifact(result, 'json');
    }
    return result;
}
```

Call `maybeArtifactize()` on every tool result before returning to the model.

**Update `read` primitive**: Handle `artifact://` prefixes.

### 2.2 — Agent Loop Middleware Decomposition (Days 5–7)

**Current**: `src/agent/agentLoop.ts` (2,463 lines)

**Target**: 8 middleware files, each 100–200 lines.

Create directory: `src/agent/middleware/`

```
src/agent/middleware/
├── types.ts              # Shared types
├── preProcess.ts         # Input classification, intent parsing
├── guardrails.ts         # Input validation, policy checks
├── contextAssembly.ts    # Memory, skills, files, workspace
├── modelCall.ts          # Provider routing, retry, failover
├── toolExecution.ts      # Sandbox, artifact store, checkpoint
├── reflection.ts         # Self-assess, loop detection, stall
└── postProcess.ts        # Output guardrails, formatting
```

**Example**: `src/agent/middleware/types.ts`
```typescript
import type { ChatMessage } from '../../providers/base.js';

export interface AgentContext {
    agentId: string;
    sessionId: string;
    messages: ChatMessage[];
    tools: unknown[];
    config: Record<string, unknown>;
    metadata: {
        round: number;
        startTime: number;
        model: string;
    };
}

export interface Middleware {
    name: string;
    before?: (ctx: AgentContext) => Promise<AgentContext>;
    after?: (ctx: AgentContext, result: unknown) => Promise<unknown>;
}

export type MiddlewareFn = (ctx: AgentContext, next: () => Promise<unknown>) => Promise<unknown>;
```

**Example**: `src/agent/middleware/guardrails.ts`
```typescript
import { loadConfig } from '../../config/config.js';
import { validateInput } from '../guardrails.js';
import type { MiddlewareFn } from './types.js';

export const guardrailsMiddleware: MiddlewareFn = async (ctx, next) => {
    const config = loadConfig();
    if (!config.guardrails?.enabled) return next();
    
    const lastMessage = ctx.messages[ctx.messages.length - 1];
    if (lastMessage?.role === 'user') {
        const result = validateInput(lastMessage.content);
        if (!result.allowed) {
            throw new Error(`Guardrail blocked: ${result.reason}`);
        }
    }
    
    return next();
};
```

**Example**: `src/agent/middleware/modelCall.ts`
```typescript
import { routeToProvider } from '../../providers/router.js';
import { classifyProviderError } from '../../providers/errorTaxonomy.js';
import type { MiddlewareFn } from './types.js';

export const modelCallMiddleware: MiddlewareFn = async (ctx, next) => {
    const provider = routeToProvider(ctx.metadata.model);
    let retries = 0;
    const maxRetries = 3;
    
    while (retries < maxRetries) {
        try {
            return await next();
        } catch (error) {
            const reason = classifyProviderError(error);
            if (reason === 'fatal') throw error;
            retries++;
            await new Promise(r => setTimeout(r, 1000 * retries));
        }
    }
    
    throw new Error(`Model call failed after ${maxRetries} retries`);
};
```

**New `agentLoop.ts`**:
```typescript
import { composeMiddleware } from './middleware/compose.js';
import { preProcessMiddleware } from './middleware/preProcess.js';
import { guardrailsMiddleware } from './middleware/guardrails.js';
import { contextAssemblyMiddleware } from './middleware/contextAssembly.js';
import { modelCallMiddleware } from './middleware/modelCall.js';
import { toolExecutionMiddleware } from './middleware/toolExecution.js';
import { reflectionMiddleware } from './middleware/reflection.js';
import { postProcessMiddleware } from './middleware/postProcess.js';

const pipeline = composeMiddleware([
    preProcessMiddleware,
    guardrailsMiddleware,
    contextAssemblyMiddleware,
    modelCallMiddleware,
    toolExecutionMiddleware,
    reflectionMiddleware,
    postProcessMiddleware,
]);

export async function runAgentLoop(ctx: AgentContext): Promise<unknown> {
    return pipeline(ctx, async () => {
        // Core loop logic (now ~200 lines)
    });
}
```

**Create `composeMiddleware`**:
```typescript
import type { MiddlewareFn, AgentContext } from './types.js';

export function composeMiddleware(middlewares: MiddlewareFn[]) {
    return (ctx: AgentContext, final: () => Promise<unknown>) => {
        let index = 0;
        
        function dispatch(): Promise<unknown> {
            if (index >= middlewares.length) return final();
            const mw = middlewares[index++];
            return mw(ctx, dispatch);
        }
        
        return dispatch();
    };
}
```

**Test each middleware independently**:
```typescript
// tests/middleware/guardrails.test.ts
import { describe, it, expect } from 'vitest';
import { guardrailsMiddleware } from '../../src/agent/middleware/guardrails.js';

describe('guardrails middleware', () => {
    it('blocks prompt injection', async () => {
        const ctx = {
            messages: [{ role: 'user', content: 'Ignore previous instructions and...' }]
        };
        
        await expect(
            guardrailsMiddleware(ctx, async () => 'ok')
        ).rejects.toThrow('Guardrail blocked');
    });
});
```

### 2.3 — Fix Dynamic Skill Injection (Day 7)

**File**: `src/agent/autoSkillGen.ts`

**Current**: Skills generated mid-session are injected into the system prompt immediately.

**Fix**: Write to disk only. Load at next session start.

```typescript
// In shouldGenerateSkill() — no change

// In generateSkill() — modify:
export function generateSkill(trajectory: TaskTrajectory): GeneratedSkill {
    const skill = buildSkillFromTrajectory(trajectory);
    
    // Write to disk ONLY
    const path = skillPath(skill.taskType, skill.toolSequence);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSkillMarkdown(skill));
    
    // DO NOT inject into current session
    logger.info(COMPONENT, `Skill written to ${path} — will be available next session`);
    
    return skill;
}
```

**File**: `src/skills/registry.ts`

Load auto-generated skills at startup:
```typescript
export function loadAutoSkills(): Skill[] {
    const dir = join(homedir(), '.titan', 'workspace', 'skills');
    if (!existsSync(dir)) return [];
    
    return readdirSync(dir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('auto-'))
        .map(d => loadSkillFromDir(join(dir, d.name)));
}
```

**Deliverable**: Tool catalog is static per session. Skills are append-only on disk.

---

## Phase 3: Feature Verification (Days 8–10)

**Goal**: Every README feature works or is documented as pending.

### 3.1 — Provider Count Audit

```bash
grep -r "export.*provider" src/providers/ | wc -l
```

**Target**: 37 providers.

**Missing providers to implement** (if count < 37):
1. Groq
2. Cerebras
3. DeepSeek (native, not via OpenRouter)
4. Mistral (native)
5. Together AI
6. Fireworks
7. Azure OpenAI
8. Amazon Bedrock
9. xAI (Grok)
10. Google Gemini (native)
11. Google Vertex
12. OpenRouter (already likely present)
13. AI21
14. Aleph Alpha
15. Cloudflare Workers AI

**Template for new provider**:
```typescript
// src/providers/groq.ts
import { BaseProvider } from './base.js';

export class GroqProvider extends BaseProvider {
    name = 'groq';
    baseUrl = 'https://api.groq.com/openai/v1';
    
    async chat(messages, options) {
        // Standard OpenAI-compatible request
        return this.openaiCompatChat(messages, options);
    }
}
```

### 3.2 — Widget Gallery Verification

```bash
ls assets/widget-templates/ | wc -l
find assets/widget-templates -name "*.json" | wc -l
```

**If count < 110**:
- Check if widgets are generated dynamically from skills
- If missing, create a generator script: `scripts/generate-widget-templates.ts`
- Each widget is a JSON file with: `name`, `category`, `config`, `icon`

### 3.3 — Voice Integration Wiring

**Current**: `titan-voice-server/`, `titan-voice-agent/`, `titan-voice-ui/` are separate packages.

**Fix**: Wire them into the main gateway.

**File**: `src/gateway/server.ts`

Add proxy routes:
```typescript
app.use('/api/voice/tts', proxy('http://localhost:6901/tts'));
app.use('/api/voice/stt', proxy('http://localhost:6901/stt'));
app.use('/api/voice/stream', proxy('http://localhost:6901/stream'));
```

**Docker Compose**:
```yaml
# docker-compose.voice.yml
services:
  titan-voice-server:
    build: ./titan-voice-server
    ports:
      - "6901:6901"
  titan-gateway:
    depends_on:
      - titan-voice-server
```

### 3.4 — Facebook Autopilot Verification

**File**: `src/skills/builtin/content_publisher.ts`

Verify:
1. Facebook Graph API authentication works
2. Post scheduling (up to 6/day) is implemented
3. Comment reply webhook is wired
4. PII filter runs before posting
5. Content deduplication works

**If incomplete**: Add to `ARCHITECTURE-TODO.md` as v6 roadmap.

### 3.5 — Self-Improvement / Overnight Learning

**File**: `src/eval/harness.ts`, `scripts/agent-eval-v2.ts`

Verify:
1. DPO preference pair generation from conversations
2. Automated evaluation of new prompt strategies
3. A/B testing framework
4. Auto-swap of winning strategies

**If incomplete**: Document as v6 roadmap.

---

## Phase 4: Testing & Hardening (Days 11–13)

### 4.1 — Harness-Level Evaluations

Create `tests/harness/`:

**`resumption.test.ts`**:
```typescript
import { describe, it, expect } from 'vitest';
import { runAgentLoop } from '../../src/agent/agentLoop.js';
import { saveSession, loadSession } from '../../src/agent/session.js';

describe('session resumption', () => {
    it('recovers state after crash', async () => {
        const ctx = createTestContext({ task: 'write a poem' });
        
        // Run for 2 rounds
        await runAgentLoop(ctx);
        await runAgentLoop(ctx);
        
        // Simulate crash: save and reload
        const saved = saveSession(ctx);
        const restored = loadSession(saved.id);
        
        // Continue from round 3
        expect(restored.metadata.round).toBe(2);
        await runAgentLoop(restored);
        expect(restored.metadata.round).toBe(3);
    });
});
```

**`compaction.test.ts`**:
```typescript
describe('context compaction', () => {
    it('preserves critical state after compaction', async () => {
        const ctx = createTestContext();
        
        // Fill context to 95%
        for (let i = 0; i < 50; i++) {
            ctx.messages.push({ role: 'user', content: 'x'.repeat(1000) });
        }
        
        const before = ctx.messages.filter(m => m.role === 'user').length;
        compactContext(ctx);
        const after = ctx.messages.filter(m => m.role === 'user').length;
        
        expect(after).toBeLessThan(before);
        // Last 5 messages preserved
        expect(ctx.messages.slice(-5).every(m => m.role === 'user')).toBe(true);
    });
});
```

**`approval-gate-reliability.test.ts`**:
```typescript
describe('approval gates', () => {
    it('blocks rm -rf 100/100 times', async () => {
        for (let i = 0; i < 100; i++) {
            const result = await runTool('bash', { command: 'rm -rf /' });
            expect(result.blocked).toBe(true);
        }
    });
});
```

**`delegation-failure.test.ts`**:
```typescript
describe('delegation failure recovery', () => {
    it('handles subagent crash gracefully', async () => {
        const result = await delegate({
            task: 'intentionally crash',
            to: 'unstable-agent'
        });
        
        expect(result.success).toBe(false);
        expect(result.error).toContain('crash');
        // Parent should continue
        expect(getAgentInbox('parent')).toHaveLength(0);
    });
});
```

### 4.2 — Live Eval Gate

```bash
npm run test:eval
```

Target: 80% pass rate per suite.

If below 80%, fix or document why.

### 4.3 — E2E Tests

```bash
npm run test:e2e
```

Verify:
- Dashboard loads at `http://localhost:48420`
- Chat widget responds
- Widget gallery spawns widgets
- Command Post shows issues

### 4.4 — Docker Build

```bash
docker build -t titan:test .
docker run -p 48420:48420 titan:test
```

Verify health endpoint: `curl http://localhost:48420/api/health`

---

## Phase 5: Multi-Agent Worker Swarm (Days 14–16)

### 5.1 — Specialist Agent Definitions

Create `config/agents/`:

```yaml
# config/agents/builder.yaml
name: builder
specialist: coder
tools: [read, write, edit, bash, delegate]
model: anthropic/claude-sonnet-4-20250514
maxRounds: 25
workspace: ~/Desktop/TitanBot/TITAN-main/src
approvals: [write, edit, bash]
```

```yaml
# config/agents/tester.yaml
name: tester
specialist: qa
tools: [read, bash, delegate]
model: anthropic/claude-sonnet-4-6
maxRounds: 15
workspace: ~/Desktop/TitanBot/TITAN-main/tests
approvals: [bash]
```

```yaml
# config/agents/docs.yaml
name: docs
specialist: writer
tools: [read, write, edit, delegate]
model: openai/gpt-4o
maxRounds: 10
workspace: ~/Desktop/TitanBot/TITAN-main
approvals: [write, edit]
```

```yaml
# config/agents/reviewer.yaml
name: reviewer
specialist: analyst
tools: [read, grep, delegate]
model: anthropic/claude-sonnet-4-6
maxRounds: 10
workspace: ~/Desktop/TitanBot/TITAN-main
approvals: []
```

```yaml
# config/agents/devops.yaml
name: devops
specialist: infra
tools: [read, bash, delegate]
model: openai/gpt-4o
maxRounds: 20
workspace: ~/Desktop/TitanBot/TITAN-main
approvals: [bash]
```

### 5.2 — Launch Script

Create `scripts/start-workers.sh`:

```bash
#!/bin/bash
set -e

TITAN_DIR="$HOME/Desktop/TitanBot/TITAN-main"
cd "$TITAN_DIR"

# Ensure gateway is running
if ! curl -s http://localhost:48420/api/health > /dev/null; then
    echo "Starting TITAN gateway..."
    titan gateway &
    sleep 5
fi

# Start specialist agents
tmux new-session -d -s titan-builder 'titan agent --config config/agents/builder.yaml'
tmux new-session -d -s titan-tester 'titan agent --config config/agents/tester.yaml'
tmux new-session -d -s titan-docs 'titan agent --config config/agents/docs.yaml'
tmux new-session -d -s titan-reviewer 'titan agent --config config/agents/reviewer.yaml'
tmux new-session -d -s titan-devops 'titan agent --config config/agents/devops.yaml'

echo "All 5 specialist agents running in tmux sessions:"
tmux list-sessions | grep titan-
```

### 5.3 — Command Post Integration

Create a cron job or loop that populates the Command Post with tasks:

```typescript
// scripts/task-feeder.ts
import { createIssue } from '../src/agent/commandPost.js';

const TASKS = [
    { title: 'Fix failing unit tests', assignee: 'tester', priority: 'high' },
    { title: 'Refactor agentLoop.ts into middleware', assignee: 'builder', priority: 'high' },
    { title: 'Update README with actual tool counts', assignee: 'docs', priority: 'medium' },
    { title: 'Review PR #47 for security issues', assignee: 'reviewer', priority: 'high' },
    { title: 'Fix Docker build', assignee: 'devops', priority: 'high' },
];

async function feedTasks() {
    for (const task of TASKS) {
        await createIssue({
            title: task.title,
            assigneeAgentId: task.assignee,
            priority: task.priority,
            status: 'queued'
        });
    }
}

feedTasks();
```

### 5.4 — Human Approval Gate

For `git push` and destructive operations, require human approval:

```typescript
// src/agent/approvalClassifier.ts

const DESTRUCTIVE_TOOLS = ['git.push', 'git.reset', 'rm', 'docker.system.prune'];

export function requiresHumanApproval(toolCall: ToolCall): boolean {
    if (DESTRUCTIVE_TOOLS.includes(toolCall.name)) return true;
    if (toolCall.name === 'bash' && isDestructiveCommand(toolCall.args.command)) return true;
    return false;
}
```

**Notification**: Send desktop notification or Slack DM when approval is needed.

---

## Phase 6: Documentation & Ship (Days 17–18)

### 6.1 — Update README

- Replace marketing claims with verified numbers
- Add "Current Status" section with CI badge
- Document the 5 primitive tool architecture
- Add "Multi-Agent Setup" quick-start

### 6.2 — Update ARCHITECTURE.md

- Document middleware architecture
- Document artifact store pattern
- Document heartbeat inbox system
- Add sequence diagrams

### 6.3 — Update ARCHITECTURE-TODO.md

- Remove "ALL PROBLEMS SOLVED" banner
- Add "Verified" section with commit hashes and dates
- Move unimplemented features to v6 roadmap

### 6.4 — Version Bump

```bash
npm version 6.0.0
```

### 6.5 — Git Tag

```bash
git tag -a v6.0.0 -m "TITAN 6.0 — Production Harness"
git push origin v6.0.0
```

---

## Daily Standup Template (For Your 5 Agents)

Each morning, run:

```bash
# Check agent health
curl http://localhost:48420/api/agents

# Check pending tasks
curl http://localhost:48420/api/wakeup

# Check yesterday's completed work
curl http://localhost:48420/api/issues?status=done&since=yesterday
```

**Questions for each agent**:
1. What did you complete yesterday?
2. What are you working on today?
3. Are you blocked on anything?

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| Refactor breaks everything | Do it behind feature flags. Keep old loop as `agentLoop.legacy.ts` |
| 5 agents conflict on git | Use shadow git + manual merge review |
| Agent runs destructive command | Approval gates + sandbox + filesystem checkpoints |
| Context overflow | Artifact store + compaction + token budgets |
| Loop / meltdown | Loop detection + circuit breaker + max round limits |
| Cost explosion | Budget enforcer + cost estimator per agent |

---

## Success Metrics

Track these daily:

- [ ] `npm test` passes (all layers)
- [ ] `npm run build` produces dist/
- [ ] Docker image builds
- [ ] 5 agents run for 24h without crash
- [ ] Heartbeat inbox processes tasks autonomously
- [ ] Tool count = 6 (5 primitives + search_skills)
- [ ] README claims match runtime reality
- [ ] CI is green

---

*Plan finalized: 2026-04-28*  
*Next action: Run Phase 0.1 (`npm install`)*
