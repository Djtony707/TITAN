# Space-Agent Analysis for TITAN

> **Date:** 2026-04-25  
> **Source:** https://github.com/agent0ai/space-agent (shallow clone at `/tmp/space-agent-analysis`)  
> **Goal:** Identify specific code patterns, features, and architectural decisions TITAN could borrow or adapt.

---

## Executive Summary

Space-agent is a **browser-first, server-last** AI agent platform. Unlike TITAN's Node.js-centric architecture, space-agent runs the agent loop, tool execution, and state management **entirely in the browser** using Alpine.js. The Node backend is thin — just CORS proxying, auth, and file serving.

This is a radically different architecture, but several patterns are highly borrowable:

1. **Prompt-budget enforcement** — ratio-based token caps with cached counts
2. **Skill frontmatter system** — Markdown + YAML auto-discovery with context tags
3. **Widget-as-function-source** — widgets store their renderer as JS source, not React components
4. **Deterministic LLM eval harness** — JSON test cases with A/B/C prompt triads
5. **Layered customware** — `L0` firmware → `L1` group → `L2` user inheritance
6. **Prompt-include memory** — `*.system.include.md` files as agent-editable memory

**Bottom line:** TITAN should adopt the **skill frontmatter**, **prompt-budget**, and **eval harness** patterns. The browser-first architecture is incompatible with TITAN's Node.js backend, but the execution protocol (`_____javascript` gate + Proxy sandbox) could inspire a client-side tool runner.

---

## Architecture Comparison

| Dimension | Space-Agent | TITAN | Verdict |
|-----------|-------------|-------|---------|
| **Runtime** | Browser (Alpine.js) | Node.js + React UI | Different — not directly comparable |
| **Agent Loop** | Frontend `onscreen_agent/execution.js` | Backend `src/agent/agentLoop.ts` | Space-agent avoids server round-trips; TITAN has richer orchestration |
| **State** | Alpine stores (`init`/`mount`/`unmount`) | React hooks + Zustand + CRDT | TITAN's CRDT spatial state is more sophisticated |
| **Tools** | `_____javascript` gate + browser eval | Backend function calls | Space-agent's sandboxed eval is interesting for client-side tools |
| **Skills** | Markdown + YAML frontmatter | TypeScript registry + JSON config | **TITAN should adopt frontmatter skills** |
| **Memory** | Prompt-include files (`*.include.md`) | Vector + graph + JSON | **TITAN should adopt prompt-includes for user memory** |
| **UI Canvas** | Signed-grid camera panning + widget-as-code | React GridLayout + system components | Different philosophies; widget-as-code enables user-generated widgets |
| **Testing** | JSON case harness + A/B/C triads | Test health monitor + canary eval | **TITAN should adopt deterministic JSON eval cases** |
| **Deployment** | Electron + `node space supervise` | systemd + rsync | Space-agent's zero-downtime supervisor is worth studying |

---

## Feature-by-Feature Deep Dive

### 1. Agent Execution Protocol
**Primary File:** `app/L0/_all/mod/_core/onscreen_agent/execution.js`

Space-agent's execution loop uses a **gated protocol** similar to TITAN's `_____react` gate:

- `_____user` — human message block
- `_____framework` — runtime telemetry (token counts, budgets)
- `_____transient` — mutable context that gets trimmed first
- `_____javascript` — code execution gate (like TITAN's tool calls)

The JavaScript gate runs in a **Proxy-scoped sandbox** using `with (proxyScope) { eval(code) }`. This allows the agent to execute arbitrary code safely without a backend round-trip.

**Borrowable for TITAN:**
- Adopt the `_____user` / `_____framework` / `_____transient` block markers in the system prompt for cleaner context separation.
- Consider a client-side JavaScript tool for rapid UI manipulation (like `document.querySelector` tweaks) without backend latency.

---

### 2. Skill System
**Primary File:** `app/L0/_all/mod/_core/skillset/skills.js`

Skills are **Markdown files with YAML frontmatter**:

```markdown
---
name: web_search
description: Search the web
context_tags: [web, research]
---

When the user asks about current events, use this skill to search...
```

The system:
1. Discovers all `SKILL.md` files recursively
2. Parses frontmatter for metadata
3. Auto-loads skills whose `context_tags` match the current conversation context
4. Detects conflicts (two skills claiming the same trigger)

**Borrowable for TITAN:**
- **High priority.** TITAN's skills are TypeScript modules in `src/skills/`. Adding a Markdown frontmatter layer would let users define skills without writing code.
- The `context_tags` auto-loading mechanism could replace TITAN's manual skill registration.
- Conflict detection would improve TITAN's skill reliability.

**Implementation sketch:**
```typescript
// src/skills/frontmatterLoader.ts
import matter from 'gray-matter';

export function loadFrontmatterSkills(dir: string): Skill[] {
  const files = globSync(`${dir}/**/SKILL.md`);
  return files.map(path => {
    const { data, content } = matter(readFileSync(path, 'utf-8'));
    return {
      name: data.name,
      tags: data.context_tags || [],
      prompt: content,
      source: path,
    };
  });
}
```

---

### 3. Widget Canvas & UI
**Primary Files:** `app/L0/_all/mod/_core/spaces/store.js`, `layout.js`

Space-agent's canvas uses a **signed integer grid** (camera panning) rather than CSS GridLayout. Widgets are stored as **YAML with embedded JavaScript source**:

```yaml
widgets:
  - id: todo-list
    x: 0
    y: 0
    w: 4
    h: 3
    source: |
      function render() {
        return `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
      }
```

The widget renderer is a **function string that gets `new Function()`'d** at runtime. This means users (and agents) can create entirely new widget types on the fly without redeploying the app.

**Borrowable for TITAN:**
- **Medium priority.** TITAN's React component registry is more robust but requires a rebuild for new widgets.
- A hybrid approach: keep system widgets as React components, but add a **"code widget"** type that accepts a JS function string and renders it in an iframe sandbox.
- This would enable the agent to generate truly novel widgets (charts, custom layouts, interactive forms) without pre-built components.

---

### 4. Memory & Prompt Context
**Primary Files:** `app/L0/_all/mod/_core/memory/`, `promptinclude/promptinclude.js`

Space-agent's memory system is elegantly simple:

1. **Prompt-include files** — `*.system.include.md`, `*.transient.include.md` in the project directory
2. **Auto-discovery** — The prompt builder scans for these files and includes them in the appropriate budget section
3. **Agent-editable** — The agent can write to these files to persist memory across sessions
4. **Source-attributed** — Each include block is fenced with its file path so the LLM knows where the context came from

**Borrowable for TITAN:**
- **High priority.** TITAN has vector/graph memory but lacks a simple file-based prompt inclusion system.
- Adding `~/.titan/includes/*.system.include.md` would let users (and agents) maintain long-lived context without database complexity.
- The agent could edit these files directly via the `write_file` tool, making memory updates transparent and version-controlled.

---

### 5. Testing & Evaluation
**Primary File:** `tests/agent_llm_performance/test.mjs`

Space-agent has a **deterministic LLM evaluation harness**:

1. **JSON test cases** — Each case has `input`, `expected_behavior`, and `assertions`
2. **A/B/C prompt triads** — Tests run against multiple prompt variants to measure robustness
3. **Living leaderboard** — Results are stored in `results/` with timestamps; a leaderboard tracks which prompt version performs best
4. **Pass/fail JSON** — The LLM outputs a JSON object with `passed: boolean` and `reason` fields

**Borrowable for TITAN:**
- **High priority.** TITAN has `testHealthMonitor.ts` but lacks structured LLM eval cases.
- Adding a JSON case format for agent behavior would enable regression testing of the widget creation pipeline.
- Example: "Given input 'show me my backups', assert that agent calls `backup_list` then `gallery_search` for `system:backup`."

---

### 6. Router & Request Handling
**Primary File:** `server/router/router.js`

Space-agent's router has three notable patterns:

1. **Fixed explicit precedence** — Routes are matched in declaration order; no magic regex fallback
2. **State-version fencing** — Each request carries a `stateVersion` header; stale requests are rejected to prevent race conditions
3. **AsyncLocalStorage auth context** — Authentication state is propagated via Node's `AsyncLocalStorage`, so any function deep in the call stack can access the current user without passing context manually

**Borrowable for TITAN:**
- **State-version fencing** could prevent the race conditions TITAN sometimes hits when rapid config changes overlap with agent runs.
- **AsyncLocalStorage auth** would clean up TITAN's auth propagation (currently passed through many function signatures).

---

## Specific Code Patterns to Borrow

### Pattern A: Prompt Budget Enforcement
```javascript
// From onscreen_agent/execution.js (paraphrased)
const BUDGETS = { system: 0.30, history: 0.40, transient: 0.30 };
function trimToBudget(entries, maxTokens) {
  const cached = entries.filter(e => e.tokenCount);
  const total = cached.reduce((s, e) => s + e.tokenCount, 0);
  if (total <= maxTokens) return entries;
  // Trim largest contributor by at least 250 tokens
  const overage = total - maxTokens;
  const sorted = cached.sort((a, b) => b.tokenCount - a.tokenCount);
  for (const entry of sorted) {
    if (overage <= 0) break;
    entry.tokenCount = Math.max(0, entry.tokenCount - Math.max(250, overage));
  }
  return entries.filter(e => e.tokenCount > 0);
}
```

**TITAN adaptation:** Add token budgeting to `agent.ts` message preparation. Cache token counts on `ChatMessage` objects to avoid re-counting.

### Pattern B: Skill Frontmatter Discovery
```javascript
// From skillset/skills.js (paraphrased)
const skills = glob('**/SKILL.md').map(path => {
  const raw = readFileSync(path, 'utf-8');
  const { data, content } = matter(raw);
  return {
    name: data.name,
    tags: data.context_tags || [],
    prompt: content,
    conflicts: data.conflicts || [],
  };
});
```

**TITAN adaptation:** Add `src/skills/frontmatter/` directory. Scan on boot. Merge with existing TypeScript skills.

### Pattern C: Prompt-Include Memory
```javascript
// From promptinclude/promptinclude.js (paraphrased)
const includes = glob('**/*.system.include.md');
const blocks = includes.map(path => ({
  role: 'system',
  content: readFileSync(path, 'utf-8'),
  source: path, // attributed for LLM transparency
}));
```

**TITAN adaptation:** Add `~/.titan/includes/` directory. Auto-include `*.system.include.md` in system prompt, `*.transient.include.md` in context appendix.

### Pattern D: Deterministic Eval Harness
```javascript
// From tests/agent_llm_performance/test.mjs (paraphrased)
const cases = JSON.parse(readFileSync('cases.json'));
for (const testCase of cases) {
  const response = await agent.run(testCase.input);
  const result = await llm.jsonMode({
    prompt: `Did the response satisfy: ${testCase.expected_behavior}?`,
    schema: { passed: 'boolean', reason: 'string' }
  });
  results.push({ id: testCase.id, passed: result.passed, reason: result.reason });
}
writeFileSync('results.json', JSON.stringify(results, null, 2));
```

**TITAN adaptation:** Add `tests/evals/agent-widget-creation.json` with cases like: "Input: 'show backups' → Expected: calls backup_list tool, emits system:backup widget."

---

## Integration Feasibility

| Pattern | Effort | Risk | Priority |
|---------|--------|------|----------|
| Prompt budget enforcement | 1-2 days | Low — additive only | High |
| Skill frontmatter | 2-3 days | Low — parallel to existing skills | High |
| Prompt-include memory | 1 day | Low — additive only | High |
| Eval harness | 2-3 days | Medium — requires eval infrastructure | Medium |
| Client-side JS sandbox | 3-5 days | High — security implications | Low |
| State-version fencing | 1 day | Low — router change only | Medium |
| AsyncLocalStorage auth | 2 days | Medium — touches many files | Medium |

---

## Recommended Actions

### Immediate (This Sprint)
1. **Add prompt-include memory** — Create `~/.titan/includes/` and auto-load `*.system.include.md` into the system prompt
2. **Add skill frontmatter loader** — Scan `src/skills/**/*.md` for `SKILL.md` files and merge with TypeScript skills
3. **Add token budget enforcement** — Cache token counts on messages, trim by budget ratios before sending to LLM

### Short-term (Next 2 Weeks)
4. **Create eval harness** — Add `tests/evals/` with JSON cases for widget creation, tool calling, and safety guardrails
5. **Add state-version fencing** — Add `stateVersion` to config API responses; reject stale agent runs

### Long-term (Next Month)
6. **Experiment with code widgets** — Add a `system:code` widget type that accepts JS source and renders in a sandboxed iframe
7. **Adopt AsyncLocalStorage auth** — Refactor auth propagation to eliminate manual context passing

---

## Files Referenced

| File | Lines | Role |
|------|-------|------|
| `app/L0/_all/mod/_core/onscreen_agent/execution.js` | ~400 | Agent loop, budget enforcement, JS sandbox |
| `app/L0/_all/mod/_core/skillset/skills.js` | ~200 | Skill discovery, frontmatter parsing, conflict detection |
| `app/L0/_all/mod/_core/spaces/store.js` | ~300 | Spatial state, widget persistence |
| `app/L0/_all/mod/_core/spaces/layout.js` | ~150 | Grid layout, first-fit packing |
| `tests/agent_llm_performance/test.mjs` | ~100 | Eval harness, case runner |
| `server/router/router.js` | ~250 | Request routing, state versioning, auth context |
| `app/L0/_all/mod/_core/promptinclude/promptinclude.js` | ~100 | Prompt inclusion, file discovery |
| `app/L0/_all/mod/_core/memory/AGENTS.md` | ~50 | Memory architecture docs |
| `AGENTS.md` (root) | ~100 | Architecture contracts |
