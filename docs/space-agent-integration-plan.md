# TITAN × Space Agent Integration Plan
## "The Agent Reshapes the Interface"

---

## 1. Executive Summary

After a complete deep-dive analysis of Space Agent's codebase (every command, the extension system, the execution engine, the widget SDK, the prompt budget system, and the Alpine.js frontend), this plan defines how to integrate Space Agent's core philosophy — **"the agent reshapes the interface"** — into TITAN's React 19 + Vite 6 + Tailwind v4 architecture.

**Space Agent's genius is not its tech stack. It's its architecture pattern:**
- The AI runs in the browser and can manipulate the UI it lives in
- No JSON tool-call bloat — the model emits `_____javascript` followed by raw JS
- Widgets are first-class: the AI generates visual tools, dashboards, and mini-apps on demand
- The system is self-extensible: the agent writes SKILL.md files that become runtime capabilities
- Git-backed time travel: every change is tracked, rollback is one click away

**TITAN's strength is its backend:**
- Robust agent loop with SSE streaming, tool calls, sessions
- 60+ API functions, multi-model support, voice integration
- Command Post with agents, workflows, approvals, organizations
- Infrastructure monitoring (homelab, mesh, nvidia, channels)
- Social media automation (Facebook, Discord, etc.)

**The integration = TITAN's backend + Space Agent's frontend agent pattern.**

---

## 2. Space Agent: What We Learned (Complete Analysis)

### 2.1 The Execution Engine (The Heart)

Space Agent's onscreen agent lives in `app/L0/_all/mod/_core/onscreen_agent/`. The execution flow:

```
User Message → LLM Call → Streaming Response
                                    ↓
                    Contains "_____javascript" on its own line?
                                    ↓
                    YES → Extract code after separator
                                    ↓
                    Wrap in AsyncFunction with Proxy scope
                                    ↓
                    Execute in browser context
                                    ↓
                    Capture console logs, return values, errors
                                    ↓
                    Format as execution-output message
                                    ↓
                    Feed back into context → next LLM turn
```

**The Proxy Scope (`createExecutionScope`):**
- A `Proxy` around `sharedState` that persists across executions
- `window`, `document`, `console`, `space` are aliased to actual browser globals
- Unrecognized variables fall through to `window[key]` with bound methods
- New variables stored in `sharedState` (or `window` if property exists)
- Console methods patched to record logs for the chat transcript

**Key insight:** The AI has FULL DOM access. It can `document.createElement`, `querySelector`, `appendChild` — manipulate the live page directly. This is both powerful and dangerous.

### 2.2 The `space` Global Runtime

Space Agent installs `globalThis.space` with these namespaces:

| Namespace | Capabilities |
|-----------|-------------|
| `space.api` | File read/write/list, Git history, user info |
| `space.spaces` | Create spaces, upsert/patch/remove widgets, save layouts |
| `space.current` | Read/see/patch widgets in current space |
| `space.browser` | Open browser windows, navigate, click, type, evaluate JS |
| `space.chat` | Messages, attachments, transient context registry |
| `space.skills` | Runtime skill loading from SKILL.md files |
| `space.extend` | Function wrapper for JS extension hooks |
| `space.fw.createStore` | Alpine store factory |

### 2.3 The Widget SDK

```js
defineWidget({
  title: "My Widget",
  size: { cols: 4, rows: 3 },
  load: async (ctx) => { /* data fetching */ },
  render: (ctx) => {
    // Returns: DOM Nodes, strings, numbers, arrays, or objects
  }
})
```

- Widgets are JavaScript functions that return DOM content
- Size presets: tiny, small, medium, large, wide, tall, full
- Max: 12 cols × 12 rows
- Rendered by `widget-render.js`: Node→mounted, Array→fragment, Object→`<pre>` JSON
- Widgets run in the SAME browser context as the app (no iframe)

### 2.4 The Extension System (Dual)

**HTML Extensions:**
```html
<x-extension id="some/path">
```
- Resolved to `mod/<author>/<repo>/ext/html/some/path/*.html`
- Batch-loaded via `/api/extensions_load`
- MutationObserver watches for dynamic insertion

**JS Extensions (`space.extend`):**
```js
space.extend(import.meta, async function myHook() { ... })
```
- Wraps functions with `/start` and `/end` hooks
- Hook files live at `ext/js/<extension-point>/*.js`
- Hooks receive `hookContext` with `args`, `result`, `error`, `skip`

### 2.5 Prompt Budget System

Default ratios (configurable):
- **System**: 30%
- **History**: 40%
- **Transient**: 30%
- **Single message cap**: 10% of history budget

Trimming strategy:
1. History single-message cap first
2. Per-part budget enforcement (system/history/transient)
3. Contributor-level trimming (individual prompt items)
4. Section-body compression fallback
5. History compaction for old turns

### 2.6 Git-Backed Time Travel

- Each writable layer root gets its own Git repository
- Adaptive debouncing: 10s → 5s → 1s → immediate
- Auth files auto-gitignored
- Time Travel UI lists commits, shows diffs, supports rollback

### 2.7 Layered Customware (L0/L1/L2)

- **L0**: Immutable firmware (repo-owned, release-updated)
- **L1**: Group customware (runtime-editable, shared)
- **L2**: User customware (runtime-editable, per-user)
- Resolution: L2 overrides L1 overrides L0
- Same module paths override; different filenames compose

---

## 3. TITAN: Current Architecture

### 3.1 Frontend (React 19 + Vite 6 + Tailwind v4)

- **Routing**: react-router v7 with lazy-loaded views
- **State**: No Redux/Zustand — local state + React Context only
- **API**: `apiFetch()` wrapper, ~60 API functions, SSE streaming
- **Auth**: JWT in localStorage, Bearer token injection
- **Chat**: SSE-based streaming with tool call indicators, agent events
- **Shell**: Icon rail + status bar + resizable panels
- **Views**: Mission (chat + activity), Command Post, Intelligence, Tools, Infra, Settings, Soma, Watch, Space (new)

### 3.2 Backend (Node.js)

- Agent loop with streaming SSE responses
- Session management
- Tool registry (shell, file, web, social media, etc.)
- Multi-model support
- Voice integration (LiveKit)
- Mesh networking
- Infrastructure monitoring

### 3.3 What's Already Built for Space

- `SpaceView.tsx` — Main panel with react-grid-layout v2
- `widgetCompiler.ts` — Simulated AI widget code generation
- `WidgetSandbox.tsx` — Sandboxed iframe renderer
- `types.ts` — TypeScript interfaces
- `/space` route registered
- "Space" nav item in IconRail
- `react-grid-layout@2.2.3` installed

---

## 4. The Gap Analysis

| Space Agent Feature | TITAN Status | Gap |
|---------------------|-------------|-----|
| Browser-first agent execution | Backend-only agent | **CRITICAL** |
| `_____javascript` separator protocol | JSON tool calls only | **CRITICAL** |
| Widget generation (AI writes code) | Simulated only | **CRITICAL** |
| Widget SDK (`defineWidget`) | No equivalent | **CRITICAL** |
| Self-extensible SKILL.md system | No equivalent | **MEDIUM** |
| Extension system (`space.extend`) | No equivalent | **MEDIUM** |
| Prompt budget enforcement | No equivalent | **MEDIUM** |
| Git-backed time travel | No equivalent | **LOW** |
| Layered customware (L0/L1/L2) | No equivalent | **LOW** |
| In-app web browsing | Has iframe (Paperclip) | **PARTIAL** |
| Local LLM (WebLLM/Transformers.js) | No equivalent | **LOW** |
| `space.api.fileRead/Write` | Has backend file tools | **PARTIAL** |
| `space.browser` automation | No equivalent | **MEDIUM** |

---

## 5. Integration Architecture

### 5.1 Core Philosophy: "TITAN Space Agent"

**We adapt Space Agent's concepts to React, not port the code.**

Space Agent uses Alpine.js + vanilla JS + no bundler. TITAN uses React 19 + Vite + TypeScript. Direct code port is impossible. Instead, we create **equivalent capabilities** using React patterns.

### 5.2 The React Adaptation Map

| Space Agent | TITAN Adaptation |
|-------------|-----------------|
| Alpine.js stores | React Context + `useReducer` + `useSyncExternalStore` |
| `space.extend()` | React Context providers + hook-based plugin registry |
| `<x-extension>` | React `children` prop + dynamic `React.lazy()` imports |
| `AsyncFunction` + Proxy scope | Web Worker with structured clone + postMessage API |
| Widget returns DOM Nodes | Widget returns React elements (via `React.createElement` or JSX compilation) |
| `defineWidget()` | React component factory with metadata |
| `_____javascript` | Same protocol, but code is React component code |
| `space.api.fileRead` | Bridge to TITAN's existing `/api/file_*` endpoints |
| `space.browser` | Enhanced iframe bridge (build on PaperclipEmbed) |
| Prompt budget | Port `prompt-items.js` logic to TypeScript |

### 5.3 The Execution Model: Web Worker + Iframe Sandbox

**Space Agent runs AI code in the main window. This is dangerous.** TITAN will use a **two-tier sandbox**:

```
┌─────────────────────────────────────────────────────────┐
│                    TITAN React App                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ SpaceView   │  │ Chat Overlay│  │ Mission Control │ │
│  │ (Grid)      │  │ (Agent)     │  │ (Existing)      │ │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────┘ │
│         │                │                              │
│  ┌──────▼──────┐  ┌──────▼──────┐                       │
│  │ Widget      │  │ Agent       │                       │
│  │ Iframes     │  │ Web Worker  │                       │
│  │ (sandboxed) │  │ (sandboxed) │                       │
│  └──────┬──────┘  └──────┬──────┘                       │
│         │                │                              │
│         └────────┬───────┘                              │
│                  │                                      │
│         ┌────────▼────────┐                             │
│         │  postMessage    │                             │
│         │  Protocol       │                             │
│         └────────┬────────┘                             │
│                  │                                      │
│  ┌───────────────▼───────────────┐                     │
│  │   SpaceAgentContext Provider  │                     │
│  │   (Bridge between main thread │                     │
│  │    and sandboxes)             │                     │
│  └───────────────────────────────┘                     │
│                          │                              │
│  ┌───────────────────────▼────────┐                    │
│  │      TITAN Backend API         │                    │
│  │  (file ops, LLM, tools, etc.)  │                    │
│  └────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
```

**Why Web Worker for the agent?**
- AI-generated code runs OFF the main thread (no UI freezing)
- `importScripts()` can load utility libraries
- `postMessage` provides clean isolation boundary
- Can still manipulate widgets via message protocol

**Why iframe for widgets?**
- Visual isolation (CSS doesn't leak)
- Can render arbitrary HTML/React
- Can be sandboxed with `sandbox="allow-scripts"`
- Cross-origin via blob URL prevents DOM access to parent

### 5.4 The `space` Runtime (React Version)

Instead of `globalThis.space`, we create a React context:

```tsx
// SpaceAgentContext provides these to widgets and the worker:
interface SpaceRuntime {
  // File operations (bridge to TITAN backend)
  api: {
    fileRead: (path: string) => Promise<string>;
    fileWrite: (path: string, content: string) => Promise<void>;
    fileList: (path: string) => Promise<string[]>;
    // ... etc
  };
  
  // Widget operations
  widgets: {
    create: (def: WidgetDefinition) => Promise<void>;
    update: (id: string, def: Partial<WidgetDefinition>) => Promise<void>;
    remove: (id: string) => Promise<void>;
    list: () => Widget[];
  };
  
  // LLM completion (bridge to backend)
  llm: {
    complete: (prompt: string) => Promise<string>;
    stream: (prompt: string, onDelta: (delta: string) => void) => Promise<void>;
  };
  
  // Browser automation (iframe bridge)
  browser: {
    open: (url: string) => Promise<string>; // returns windowId
    navigate: (windowId: string, url: string) => Promise<void>;
    evaluate: (windowId: string, script: string) => Promise<any>;
  };
  
  // State sharing
  state: Map<string, any>; // Shared state across executions
}
```

### 5.5 The Widget SDK (React Version)

```tsx
interface WidgetDefinition {
  id: string;
  title: string;
  size: { cols: number; rows: number };
  // Code can be React component code (as string) or a function reference
  code: string; // React component source code
  // Or pre-compiled:
  component?: React.FC<WidgetProps>;
}

interface WidgetProps {
  runtime: SpaceRuntime;
  data: any;
  width: number;
  height: number;
}
```

Widgets are compiled using a lightweight JSX transformer (like `@babel/standalone` or a custom Buble build) inside the Web Worker, then rendered in an iframe with React.

### 5.6 The Execution Protocol

**Space Agent uses `_____javascript`. TITAN Space will use `_____widget` and `_____react`:**

```
Assistant Message:
"I'll create a CPU monitoring widget for your homelab.

_____widget
const { useState, useEffect } = React;

export default function CpuWidget({ runtime }) {
  const [stats, setStats] = useState(null);
  
  useEffect(() => {
    const interval = setInterval(async () => {
      const data = await runtime.api.fetch('/api/system/stats');
      setStats(data);
    }, 5000);
    return () => clearInterval(interval);
  }, []);
  
  return (
    <div className="p-4">
      <h3>CPU Usage</h3>
      <div className="text-2xl">{stats?.cpu}%</div>
    </div>
  );
}
```

The parser extracts the code block, compiles it in the Web Worker, and injects it as a new widget in the grid.

---

## 6. Use Cases: What Users Want AI to Do

### 6.1 Mission Control Dashboards

**User says:** *"Show me a real-time view of my TITAN PC — CPU, memory, disk, network, GPU."*

**What the agent does:**
1. Generates a widget that polls `/api/system/stats` every 5 seconds
2. Renders gauges, sparklines, and alert badges
3. Sizes it as `large` (8×6) for prominence
4. Auto-refreshes without page reload

**Why this is better than static dashboards:**
- User didn't specify layout, colors, or chart types — the AI chose optimal ones
- If user says "make it darker" or "add temperature," agent patches the widget live
- Widget persists across sessions (saved to backend)

### 6.2 Social Media Command Center

**User says:** *"Build me a dashboard for all my social accounts — show latest posts, engagement, scheduled content."*

**What the agent does:**
1. Creates multiple widgets: Facebook feed, Discord status, engagement chart
2. Links them: clicking a post in the feed widget highlights it in the engagement widget
3. Adds a "compose" widget with cross-post buttons
4. Arranges them in a 2×2 grid optimized for the screen size

### 6.3 Development Workspaces

**User says:** *"I need a PR review panel showing open pull requests across my repos."*

**What the agent does:**
1. Fetches PR data via TITAN's GitHub tool integration
2. Creates a sortable table widget with PR title, author, status, age
3. Adds a detail pane widget that shows diff stats when a row is clicked
4. Includes an "approve" button that calls the backend API

### 6.4 Data Visualization & Analysis

**User says:** *"Upload this CSV and show me trends."*

**What the agent does:**
1. Parses CSV in the worker using PapaParse
2. Generates a chart widget with Recharts (pre-loaded in iframe)
3. Creates a summary stats widget (mean, median, outliers)
4. Adds a filter widget for interactive exploration

### 6.5 Automation Control Panels

**User says:** *"Make me a control panel for my common scripts — backup, sync, restart services."*

**What the agent does:**
1. Lists available scripts from TITAN's tool registry
2. Creates button widgets with icons and status indicators
3. Each button calls `runtime.api.runTool('script_name')`
4. Shows output in a log widget below

### 6.6 Monitoring & Alerting

**User says:** *"Alert me when my homelab CPU goes over 80% for more than 5 minutes."*

**What the agent does:**
1. Creates a monitoring widget that tracks CPU over time
2. Implements threshold logic with hysteresis
3. Adds an alert widget that shows red banner + plays sound
4. Includes a "snooze" and "acknowledge" button

### 6.7 Research & Analysis

**User says:** *"Track mentions of 'AI agents' on Hacker News and Reddit, summarize daily."*

**What the agent does:**
1. Creates a fetcher widget that polls APIs via TITAN's proxy
2. Stores results in `runtime.state` (shared across widgets)
3. Creates a summary widget that runs LLM summarization
4. Adds a timeline widget showing mention volume over time

### 6.8 Custom Tools (The "Build Your Own" Use Case)

**User says:** *"I need a JSON formatter that also validates against a schema."*

**What the agent does:**
1. Generates a widget with textarea input
2. Adds real-time validation using Zod (pre-loaded)
3. Shows formatted output with syntax highlighting
4. Includes "copy" and "download" buttons

---

## 7. Bleeding-Edge Features (Beyond Space Agent)

### 7.1 Widget-to-Widget Communication ("The Mesh")

Widgets can subscribe to a shared event bus:

```tsx
// Widget A emits:
runtime.emit('stock:selected', { symbol: 'AAPL' });

// Widget B listens:
useEffect(() => {
  return runtime.on('stock:selected', (data) => {
    setSymbol(data.symbol);
  });
}, []);
```

This enables **dashboard composition** where widgets feed each other data.

### 7.2 Self-Improving Widgets

Widgets can request their own modification:

```tsx
// Inside a widget:
const handleUserFeedback = (feedback) => {
  runtime.llm.complete(
    `User said: "${feedback}" about this widget. ` +
    `Current code: ${runtime.widgets.getCurrentCode()}. ` +
    `Suggest a patch.`
  ).then(patch => {
    runtime.widgets.patch(patch);
  });
};
```

### 7.3 Multi-Modal Widgets

Widgets can render:
- **Text/Markdown** (via ReactMarkdown)
- **Charts** (via Recharts, pre-loaded)
- **Images** (via URL or base64)
- **Video** (via HTML5 video)
- **3D** (via Three.js, on-demand load)
- **Maps** (via Leaflet, on-demand load)

### 7.4 Voice-Controlled Widget Creation

User speaks: *"Add a widget showing my Facebook post performance"*
→ Voice transcription → LLM → `_____widget` code → compiled → rendered

### 7.5 Git-Backed Widget History

Every widget change is a Git commit:
- User can browse widget history
- Roll back to any previous version
- Branch widgets (A/B test layouts)
- Share widgets via GitHub gists

### 7.6 The "Skill Store" (Self-Extensible)

Users can save widget patterns as reusable skills:

```markdown
<!-- ~/skills/chart-from-csv.skill.md -->
# Chart from CSV

When the user uploads a CSV, create a Recharts line chart widget.
Use the first column as X-axis, numeric columns as Y-series.
```

The agent reads these skill files and includes them in its system prompt.

### 7.7 Collaborative Spaces

Multiple users can view the same Space:
- Real-time cursor presence
- Widget changes sync via WebSocket
- Permission levels (view / edit / admin)
- Comments on widgets

### 7.8 Mobile-First Responsive Widgets

Widgets declare responsive behavior:
```tsx
size: {
  lg: { cols: 6, rows: 4 },
  md: { cols: 4, rows: 3 },
  sm: { cols: 2, rows: 2 }
}
```

---

## 8. Previous Plan Status (Carry-Over Work)

From the previously approved "Hybrid Frontend Agent + Backend" plan, the following is complete and what remains:

### ✅ Already Completed
- [x] SpaceView scaffolded with `react-grid-layout` v2 (build passing)
- [x] Widget TypeScript interfaces (`ui/src/space-agent/types.ts`)
- [x] Widget compiler stub with `_____widget` separator support (`ui/src/space-agent/widgetCompiler.ts`)
- [x] Widget sandbox iframe renderer (`ui/src/space-agent/WidgetSandbox.tsx`)
- [x] `/space` route registered in `App.tsx`
- [x] "Space" nav item added to `IconRail.tsx` with `LayoutGrid` icon
- [x] `react-grid-layout@2.2.3` installed and building

### ⏳ Remaining from Previous Plan (MUST complete)
- [ ] **Real LLM integration** — Replace simulated `generateWidgetCode()` with actual backend calls
- [ ] **Widget persistence** — Save/load widget layouts and code (localStorage for prototype, backend for production)
- [ ] **Web Worker agent runtime** — Move widget compiler off main thread
- [ ] **`_____javascript` execution** — Port Space Agent's `AsyncFunction` + Proxy scope pattern
- [ ] **Extension system** — Adapt `space.extend` concept for React
- [ ] **Git-backed history** — Track widget changes with auto-commit
- [ ] **Prompt budget enforcement** — Tiered trimming system
- [ ] **rsync to TITAN PC and deploy**

---

## 9. Implementation Phases (Integrated)

### Phase 1: Foundation + Carry-Over Completion (Week 1-2)
**Goal: Get from scaffold to working end-to-end widget generation.**

- [x] SpaceView with react-grid-layout v2 (DONE)
- [x] Widget types, compiler stubs, sandbox (DONE)
- [x] Route and nav integration (DONE)
- [ ] **Wire up real LLM** — Create `/api/space/generate` endpoint or reuse `streamMessage()`
  - Backend: Accept user prompt, forward to LLM with system prompt teaching `_____widget` protocol
  - Frontend: Replace `setTimeout` mock in `SpaceView.tsx` with actual `streamMessage()` call
  - Parse streaming response for `_____widget` blocks in real-time
- [ ] **Widget persistence v1** — localStorage for prototype
  - Save widget definitions to `localStorage.setItem('titan-space-widgets', ...)`
  - Load on SpaceView mount
  - Save layout state from react-grid-layout
- [ ] **Web Worker agent runtime v1** — Basic compilation worker
  - `ui/src/space-agent/worker.ts` — Web Worker entry
  - Receives code strings via `postMessage`, compiles with `new Function()` (in worker context)
  - Returns compiled component or error
  - Main thread: `WidgetSandbox` receives compiled component via message and renders
- [ ] **`space` runtime context provider**
  - `SpaceAgentProvider.tsx` wrapping the app
  - Exposes `runtime.api` bridged to TITAN's existing `apiFetch()`
  - Exposes `runtime.widgets.create/update/remove/list`
  - Exposes `runtime.state` (shared Map across widgets)

### Phase 2: Execution Engine + Security (Week 3)
**Goal: Port Space Agent's execution model safely to React.**

- [ ] **Iframe widget sandbox with React**
  - Blob URL iframe with `sandbox="allow-scripts"`
  - Pre-load React 19, ReactDOM, Tailwind CSS (via CDN or inline)
  - PostMessage protocol: parent sends `{ type: 'render', code, props }`, iframe sends `{ type: 'error' | 'log' | 'rendered' }`
  - Escape hatch: widgets can call `parent.postMessage({ type: 'api', method, args }, '*')` for bridge access
- [ ] **Backend endpoints for widget persistence**
  - `POST /api/space/widget` — save widget (validates code for banned patterns)
  - `GET /api/space/widgets` — list user's widgets
  - `DELETE /api/space/widget/:id` — delete widget
  - `POST /api/space/layout` — save grid layout
  - `GET /api/space/layout` — load grid layout
- [ ] **Security validation**
  - Code scanner: ban `eval`, `Function`, `document.write`, `fetch` (force bridge), `localStorage` (force bridge)
  - CSP headers on iframe blob
  - Execution timeout in Web Worker (5s default)

### Phase 3: Space Agent Feature Parity (Week 4-5)
**Goal: Port the competitive features that make Space Agent unique.**

- [ ] **`_____javascript` protocol support**
  - Parser extracts JS code blocks after `_____javascript` separator
  - Execute in Web Worker with Proxy scope (adapted from Space Agent's `execution.js`)
  - Console log capture
  - Shared state persistence across executions (`runtime.state`)
  - Format execution results as chat messages
- [ ] **Extension system v1 (React adaptation)**
  - Instead of `space.extend()`, use React Context + hook registry
  - `useSpaceExtension(point, callback)` hook
  - Extension points: `widget:beforeCreate`, `widget:afterRender`, `chat:beforeSend`, `chat:afterReceive`
  - Extensions stored in `localStorage` as user scripts
- [ ] **Prompt budget system**
  - Port Space Agent's tiered trimming to TypeScript
  - System: 30%, History: 40%, Transient: 30% defaults
  - Contributor-level trimming with 250-token minimum step
  - History compaction for long conversations
- [ ] **Git-backed widget history**
  - Reuse TITAN's existing Git infrastructure if available
  - Or use `isomorphic-git` in browser for lightweight history
  - Auto-commit on widget save with adaptive debouncing
  - Time Travel UI: list commits, preview, rollback

### Phase 4: Widget SDK + Templates (Week 6)
**Goal: Make widget creation effortless.**

- [ ] **Pre-loaded libraries in iframe**
  - React 19, ReactDOM, Recharts, Lucide React (icons)
  - Tailwind CSS classes (inject class names, not full TW build)
  - Date-fns, PapaParse (CSV)
- [ ] **Widget template gallery**
  - 10 starter widgets: StatsCard, LineChart, BarChart, Table, Markdown, ImageGallery, ButtonPanel, LogViewer, StatusGrid, RecentActivity
  - User says "create a stats widget" → agent picks StatsCard template + fills data
- [ ] **Widget property editor**
  - Click widget → sidebar shows editable props (title, color, refresh interval, data source)
  - Live preview as user edits
- [ ] **Widget import/export**
  - Export: JSON with `{ id, title, code, layout, version }`
  - Import: Drag JSON file onto grid
  - Share via URL-encoded hash

### Phase 5: Bleeding Edge (Week 7-8)
**Goal: Surpass Space Agent.**

- [ ] **Widget-to-widget communication (event bus)**
  - `runtime.emit(event, data)` / `runtime.on(event, handler)`
  - Example: Chart widget emits `timeRangeChanged` → Table widget filters
- [ ] **Self-improving widgets**
  - "Fix this widget" button sends widget code + error to LLM
  - LLM returns patch → apply via `widgetCompiler.ts`
  - Track improvement history
- [ ] **Skill system (SKILL.md)**
  - Discover `.md` files in `~/titan/skills/`
  - Parse frontmatter for `metadata.when`, `metadata.loaded`, `metadata.placement`
  - Inject skill instructions into system prompt
- [ ] **Collaborative spaces**
  - WebSocket room per space
  - Cursor presence, live widget sync
  - Permission levels
- [ ] **Voice-controlled widget creation**
  - Reuse TITAN's existing LiveKit voice integration
  - "Create a CPU widget" → voice transcript → LLM → widget
- [ ] **Mobile responsive layouts**
  - Widgets declare `size.lg/md/sm/xs`
  - Grid adapts breakpoints
  - Touch-friendly drag handles
- [ ] **Performance optimization**
  - Widget code splitting (lazy load heavy libraries)
  - Virtual grid (only render visible widgets)
  - Worker pooling for compilation
- [ ] **rsync to TITAN PC and deploy**
  - Build production bundle
  - rsync to TITAN PC
  - Restart service
  - Verify deployment health

---

## 10. Immediate Next Steps (What to Do Right Now)

Based on the carry-over work, the immediate priorities are:

1. **Wire up real LLM** — The mock `generateWidgetCode()` is the biggest blocker. Create a backend endpoint or reuse existing `streamMessage()` to get actual AI-generated widgets.
2. **Add localStorage persistence** — So widgets survive page reloads during development.
3. **Build the Web Worker** — Move compilation off main thread.
4. **Enhance WidgetSandbox** — Pre-load React in the iframe so generated code can use JSX.

These 4 tasks unlock the core "agent reshapes the interface" experience.

---

## 9. Security Model

Space Agent runs AI code in the main window with a Proxy scope. **This is insecure.** TITAN will be more conservative:

| Threat | Mitigation |
|--------|-----------|
| AI code steals auth tokens | Widgets run in cross-origin iframe (different origin from main app) |
| AI code accesses localStorage | Iframe sandbox + blob URL = separate origin |
| AI code makes unauthorized API calls | All API calls go through `runtime.api` bridge (validated backend) |
| AI code runs infinite loops | Web Worker has execution timeout (5s default) |
| AI code uses eval/new Function | Banned via CSP in iframe |
| AI code exfiltrates data | Network requests intercepted by iframe service worker |
| Malicious widget persistence | Backend validates widget code before saving |
| Prompt injection | User input sanitized before reaching LLM |

**The security principle: widgets are UNTRUSTED, the bridge is TRUSTED.**

---

## 10. Files to Create / Modify

### New Files
```
ui/src/space-agent/
  SpaceAgentProvider.tsx      # React context for space runtime
  WorkerRuntime.ts            # Web Worker entry point
  widgetCompiler.ts           # Code → compiled widget (enhanced)
  WidgetSandbox.tsx           # Iframe renderer (enhanced)
  WidgetSDK.ts                # defineWidget() equivalent
  protocol.ts                 # _____widget parser
  SkillLoader.ts              # SKILL.md discovery
  PromptBudget.ts             # Token budget enforcement
  types.ts                    # Shared types (exists, enhance)

server/src/api/space/
  widget_save.ts
  widget_list.ts
  widget_delete.ts
  widget_compile.ts
  space_state.ts
```

### Modified Files
```
ui/src/App.tsx                # Add SpaceAgentProvider wrapper
ui/src/components/admin/SpaceView.tsx  # Full implementation
ui/src/api/client.ts          # Add space widget endpoints
server/src/router.ts          # Add space API routes
```

---

## 11. Competitive Differentiation

**Space Agent is impressive, but TITAN can be BETTER:**

| Feature | Space Agent | TITAN Space (Planned) |
|---------|-------------|----------------------|
| Widget sandbox | Main window (insecure) | Iframe + Web Worker (secure) |
| UI framework | Alpine.js | React 19 (industry standard) |
| Widget language | Vanilla JS | React + JSX (familiar) |
| Charts | Manual DOM | Recharts (declarative) |
| Collaboration | None | Real-time WebSocket sync |
| Backend | Thin file server | Full agent loop + tools |
| Social media | None | Facebook, Discord, etc. |
| Voice | None | LiveKit integration |
| Infrastructure | None | Homelab, mesh, GPU monitoring |
| Self-improvement | SKILL.md files | SKILL.md + auto-patch loop |

**The pitch: "Space Agent makes widgets. TITAN Space makes intelligent, connected, self-improving mission control panels."**

---

## 12. Success Metrics

1. **Widget creation time**: User request → rendered widget < 10 seconds
2. **Widget diversity**: 20+ unique widget types in first month
3. **User retention**: Users with custom widgets have 3× higher session frequency
4. **Agent accuracy**: >90% of widget generation requests produce working widgets on first try
5. **Security**: Zero XSS or data exfiltration incidents

---

*Plan written after complete analysis of Space Agent v0.36.0 codebase (all commands, agent loop, execution engine, widget SDK, extension system, prompt budget, and frontend architecture).*
