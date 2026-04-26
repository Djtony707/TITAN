# TITAN 3.0 — Complete Overhaul Plan

> **Status:** Draft | **Mandate:** Bleeding edge, prototype mindset, go wild.  
> **Constraint:** Keep SOMA, Command Post, Intelligence, Infra, Voice, Tools, and all existing TITAN functions.  
> **Transformation:** Every menu, page, and UI surface becomes a Canvas widget.

---

## 1. Vision: The Agent-Native Canvas

TITAN 3.0 is not a dashboard with an AI chat panel attached. It is a **living Canvas** where:
- Every feature is a widget.
- The AI agent lives *inside* the Canvas runtime and can create, edit, move, and destroy widgets.
- There are no "pages" — only spaces (widget layouts) that the agent and user co-author.
- Navigation is itself a widget.
- SOMA is a persistent ambient consciousness orb, not a separate page.

**Inspiration drawn from:**
- Space Agent (`agent0ai/space-agent`) — browser-first AI execution, `_____javascript` protocol, widget-as-function model.
- Paperclip (`paperclipai/paperclip`) — adapter registry, execution workspaces, run transcripts.
- ObservableHQ — reactive notebooks as documents.
- Raycast — command palette as primary navigation.

---

## 2. Core Architecture

### 2.1 The Three Laws

1. **Everything is a widget.** If it renders, it is a widget. No exceptions.
2. **The agent executes in the frontend.** AI output is JavaScript/JSX that runs in a sandboxed iframe, not backend API calls.
3. **State is local-first.** Layouts, widgets, and user data live in the browser first, sync to backend opportunistically.

### 2.2 Layer Model (inspired by Space Agent L0/L1/L2)

```
┌──────────────────────────────────────────────────────────────┐
│  L2: USER SPACE                                              │
│  - User-created widgets (AI-generated or hand-built)         │
│  - Personal layouts, private spaces                          │
│  - Stored in IndexedDB + optional cloud sync                 │
├──────────────────────────────────────────────────────────────┤
│  L1: GROUP/TEAM SPACE                                        │
│  - Shared widget presets, team dashboards                    │
│  - Role-based widget visibility                              │
│  - CRDT-synced for real-time collaboration                   │
├──────────────────────────────────────────────────────────────┤
│  L0: TITAN FIRMWARE (immutable)                              │
│  - Core framework: React 19 + Vite 6 + Tailwind v4           │
│  - Widget runtime: iframe sandbox + postMessage bridge       │
│  - Canvas engine: react-grid-layout + infinite pan/zoom      │
│  - AI executor: SES-shielded iframe with _____protocol       │
│  - System widgets: SOMA, Command Post, Intelligence, etc.    │
└──────────────────────────────────────────────────────────────┘
```

### 2.3 The Widget Runtime

Each widget runs in an **iframe sandbox** with the following capabilities:

```typescript
interface WidgetSandbox {
  // DOM access (scoped to widget container only)
  render: (html: string) => void;
  
  // TITAN API bridge (postMessage)
  titan: {
    api: { fetch: /* proxied fetch */, call: /* backend API */ };
    canvas: { createWidget, moveWidget, resizeWidget, removeWidget };
    state: { get, set, subscribe }; // CRDT-backed
    llm: { complete, stream }; // Direct LLM access
    tools: { call: /* MCP/tool call */ };
  };
  
  // Module imports (whitelisted)
  import: (module: string) => Promise<any>;
  
  // Shared scripts from the space
  space: { scripts: Record<string, string> };
}
```

**Sandbox security:**
- `sandbox="allow-scripts"` + `allow-same-origin` (for module loading)
- SES (Secure ECMAScript) from Agoric to freeze prototypes
- CSP: `default-src 'none'; script-src 'self' blob:; connect-src 'self' https://api.titan.io`
- No access to `localStorage`, `document.cookie`, `window.parent` without postMessage bridge

### 2.4 Widget Formats (Dual Mode)

Widgets can be authored in two formats:

**Format A: React/JSX Widget (TITAN Native)**
```yaml
schema: titan-widget/v1
id: weather
name: Weather
w: 4
h: 3
format: react
source: |
  import React, { useState, useEffect } from 'react';
  export default function WeatherWidget() {
    const [data, setData] = useState(null);
    useEffect(() => { fetch('/api/weather').then(r => r.json()).then(setData); }, []);
    return <div>{data?.temp}°C</div>;
  }
```

**Format B: Vanilla JS Widget (Space Agent Model)**
```yaml
schema: titan-widget/v1
id: crypto-ticker
name: Crypto Ticker
w: 6
h: 2
format: vanilla
source: |
  async (container, context) => {
    const res = await context.titan.api.fetch('/api/crypto');
    const data = await res.json();
    container.innerHTML = `<div class="ticker">BTC: $${data.btc}</div>`;
    return () => { /* cleanup */ };
  }
```

**Format C: Markdown/Notebook Widget (Observable-inspired)**
```yaml
schema: titan-widget/v1
id: analysis
name: Market Analysis
w: 8
h: 6
format: notebook
source: |
  # Market Analysis
  ```js
  const data = await titan.api.call('/api/market-data');
  display(lineChart(data.prices));
  ```
  The S&P 500 is up ${data.change}% today.
```

### 2.5 The Agent Execution Protocol

The on-Canvas agent uses a multi-gate protocol:

```
_____javascript  → Execute JS in widget sandbox (browser-side)
_____react       → Compile JSX and mount as React widget
_____tool        → Call backend tool/MCP adapter
_____widget      → Create/update a widget (legacy TITAN protocol, kept)
_____framework   → Runtime telemetry (execution results, state changes)
_____transient   → Mutable context injected into prompt
```

**Execution flow:**
1. User sends message via `chat-widget` (floating or docked).
2. LLM streams response.
3. Parser watches for gate markers in the stream.
4. On `_____javascript`: extract code, run in sandbox, capture logs/return/error.
5. Format execution telemetry as `_____framework` message.
6. Append to thread, continue LLM stream.
7. On `_____react`: compile JSX via Babel, create widget via Canvas runtime.
8. On `_____tool`: execute backend tool via TITAN Gateway, return result.
9. Loop until LLM emits `$terminal_response` (no execution gates).

---

## 3. Menu → Widget Migration Plan

### 3.1 Navigation Death and Rebirth

**KILL:**
- Sidebar navigation (`TitanSidebar`)
- Breadcrumb bar (`BreadcrumbBar`)
- Top-level route-based pages (`/soma`, `/intelligence`, `/command-post`, etc.)
- Properties panel as a fixed right sidebar

**BIRTH:**
Every former "page" becomes a **Space** (a widget layout). Navigation is done by:

1. **`nav-widget`** — A widget that shows available spaces. Clicking a space loads its widget layout.
2. **`command-palette-widget`** — Raycast-style CMD+K overlay for fuzzy-searching spaces, widgets, and actions.
3. **`breadcrumb-widget`** — Context-aware breadcrumbs that live inside the active space header.
4. **Route sync** — URLs like `/space/soma` or `/space/command-post` load the corresponding widget layout. The Canvas is always the route target.

### 3.2 Feature → System Widget Map

| Old Page/Feature | New System Widget | Widget ID |
|-----------------|-------------------|-----------|
| SOMA | `soma-widget` | Floating ambient orb + expanded consciousness panel |
| Command Post | `command-post-widget` | Agent control panel with run buttons, status, logs |
| Intelligence | `intelligence-widget` | Memory graph, wiki search, knowledge explorer |
| Infrastructure | `infra-widget` | Monitoring charts, server status, alerts |
| Voice Overlay | `voice-widget` | STT/TTS controls, voice transcript, settings |
| Tools / MCP | `tools-widget` | Tool registry, MCP server management, skill browser |
| Files | `files-widget` | File explorer, upload, download |
| Settings | `settings-widget` | System config, theme, LLM provider, API keys |
| Chat/Comms | `chat-widget` | The agent chat surface (can be floating or docked) |
| Nav | `nav-widget` | Space launcher, recent spaces, favorites |
| Command Palette | `cmd-palette-widget` | CMD+K fuzzy search |
| Activity Feed | `activity-widget` | Notifications, run logs, agent activity |
| Users/Teams | `users-widget` | User management, permissions (admin) |
| Dashboard | `dashboard-widget` | Stats, metrics, quick actions |

### 3.3 SOMA Integration

SOMA is no longer a page you navigate to. It is **always present** as:

- **Compact mode:** A floating orb (like Space Agent's astronaut) in a corner of the Canvas. Shows emotion/state color.
- **Expanded mode:** A full widget that can be placed on the grid. Shows consciousness graph, memory stream, emotional state.
- **Ambient mode:** SOMA state feeds into the agent's transient context. The agent "feels" what SOMA feels.
- **Interaction:** Click the orb → expands to `soma-widget`. Right-click → quick actions ("SOMA, summarize my workspace").

### 3.4 Spaces (Canvas Layouts)

A **Space** is a named, persistable widget layout:

```typescript
interface Space {
  id: string;
  name: string;
  icon: string;
  color: string;
  widgets: Widget[];
  agentInstructions?: string; // Custom prompt context for this space
  scripts?: Record<string, string>; // Shared JS modules
  createdAt: string;
  updatedAt: string;
}
```

**Built-in spaces:**
- `home` — Dashboard + nav + recent activity
- `soma` — SOMA orb + consciousness panel + memory graph
- `command` — Command Post + agent runners + transcript viewers
- `intelligence` — Wiki + memory search + knowledge tools
- `infra` — Monitoring + alerts + server status
- `tools` — MCP registry + skill manager + tool tester
- `settings` — Settings + user profile + API keys
- `voice` — Voice controls + transcript + TTS settings

**User-created spaces:**
- "Daily Standup" — Activity + chat + notes
- "Crypto Dashboard" — Prices + charts + news (Space Agent example)
- "Dev Workspace" — Terminal + files + git status

---

## 4. The Chat Surface

### 4.1 Floating Agent (Space Agent Model)

The chat is a **floating overlay**, not a sidebar:

- **Compact:** Small bubble with agent avatar. Click to expand.
- **Full:** Draggable panel with history, input, attachments.
- **Inline:** Can be docked as a widget on the Canvas grid.
- **Keyboard:** `CMD+J` toggles compact/full. `CMD+K` opens command palette.

### 4.2 Streaming Execution Transcript

As the agent works, the chat shows a live transcript:

```
[User] Create a weather widget
[Agent] I'll fetch weather data and render a widget.
[Agent] _____javascript
  const res = await fetch('...');
  ...
[Framework] execution success
  result: { temp: 22, condition: "Sunny" }
[Agent] _____react
  <WeatherWidget temp={22} condition="Sunny" />
[Framework] widget created: weather-1
[Agent] Done! The weather widget is now on your Canvas.
```

### 4.3 Quick Actions (Widget Spawners)

Pre-defined prompts that spawn specific widget layouts:
- "Open Command Post" → loads `command` space
- "Show me SOMA" → expands SOMA orb
- "Create a crypto dashboard" → spawns 3 crypto widgets
- "Start voice mode" → opens voice-widget + starts listening

---

## 5. State Architecture

### 5.1 CRDT-First (Yjs)

Use **Yjs** for all shared state:

```typescript
// Canvas layout is a Y.Array of Y.Maps
const yDoc = new Y.Doc();
const yWidgets = yDoc.getMap('widgets');
const yLayout = yDoc.getArray('layout');

// Changes sync via WebRTC (p2p) or WebSocket (server)
const provider = new WebrtcProvider('titan-space-123', yDoc);
```

**Benefits:**
- Offline-first: works without server
- Real-time collaboration: multiple users see widget moves instantly
- Conflict-free: no "last write wins" bugs
- History: Yjs has built-in undo/redo

### 5.2 Persistence Layers

```
L0 (Firmware)   → Repo-owned, versioned, read-only
L1 (Group)      → Team-shared, CRDT-synced, backend-persisted
L2 (User)       → Personal, local-first, IndexedDB + optional cloud
```

### 5.3 Backend Role (Thin)

The TITAN Gateway becomes thinner:

| Old Role | New Role |
|----------|----------|
| Run backend agents | Proxy LLM requests, optional |
| Store widget layouts | Sync CRDT updates, backup |
| Serve UI | Serve static build + API routes |
| Voice server | Keep as-is (STT/TTS pipeline) |
| Auth | Keep as-is (session + permissions) |
| MCP/tools | Keep as-is (tool execution) |

---

## 6. Implementation Phases

### Phase 0: Foundation (Week 1)
- [ ] Set up iframe sandbox runtime (`ui/src/runtime/sandbox/`)
- [ ] Build widget loader (YAML → React or Vanilla)
- [ ] Create `CanvasContext` v2 with CRDT integration
- [ ] Implement widget CRUD API (create, read, update, delete, move)
- [ ] Build `nav-widget` as first system widget

### Phase 1: Widget-ize Everything (Week 2)
- [ ] Convert each legacy page to a system widget:
  - `soma-widget`, `command-post-widget`, `intelligence-widget`
  - `infra-widget`, `voice-widget`, `tools-widget`
  - `settings-widget`, `files-widget`, `activity-widget`
- [ ] Remove sidebar, breadcrumb, properties panel
- [ ] Implement Spaces (save/load widget layouts)
- [ ] Route migration: all routes → `/space/:spaceId`

### Phase 2: Agent Protocol (Week 3)
- [ ] Implement `_____javascript` execution in sandbox
- [ ] Build streaming parser (detect gates in LLM stream)
- [ ] Implement turn loop (execute → telemetry → continue)
- [ ] Port chat from CommsPanel to floating `chat-widget`
- [ ] Add `_____react` gate for JSX widget generation
- [ ] Add `_____tool` gate for backend tool calls

### Phase 3: Polish & SOMA (Week 4)
- [ ] SOMA orb (compact) + expanded widget
- [ ] Command palette (`cmd-palette-widget`)
- [ ] CRDT sync (WebRTC + WebSocket fallback)
- [ ] Offline mode (IndexedDB persistence)
- [ ] Space sharing (export/import ZIP)
- [ ] Onboarding flow (empty space → examples)

### Phase 4: Bleeding Edge (Week 5+)
- [ ] **WebLLM integration** — Run local LLM in browser (llama.cpp via WASM)
- [ ] **WebContainer sandbox** — Optional full Node.js environment for advanced widgets
- [ ] **Agent self-modification** — Agent can edit its own system prompt, skills, and widgets
- [ ] **Hierarchical agents** — Sub-agents that run in child widgets with isolated state
- [ ] **Voice-native** — Talk to TITAN, it talks back, all via Canvas

---

## 7. Risk Assessment

| Risk | Mitigation |
|------|------------|
| iframe sandbox XSS | SES + strict CSP + whitelisted APIs |
| CRDT sync conflicts | Yjs handles this natively |
| Performance (26k users) | Lazy-load widgets, virtualize grid, Web Workers |
| LLM token cost | Local-first (Ollama), prompt compression, budget enforcement |
| Breaking existing users | Keep legacy routes as redirectors to new spaces |
| Browser storage limits | Compress widgets, shard by space, backend overflow |

---

## 8. File Structure

```
TITAN-main/
├── ui/
│   ├── src/
│   │   ├── main.tsx                    # Entry point
│   │   ├── App.tsx                     # Router (only /space/:id)
│   │   ├── runtime/                    # L0: Firmware
│   │   │   ├── sandbox/                # iframe sandbox runtime
│   │   │   ├── crdt/                   # Yjs integration
│   │   │   ├── canvas/                 # Canvas engine (react-grid-layout wrapper)
│   │   │   └── agent/                  # Agent execution protocol
│   │   ├── system-widgets/             # L0: System widgets
│   │   │   ├── soma/
│   │   │   ├── command-post/
│   │   │   ├── intelligence/
│   │   │   ├── infra/
│   │   │   ├── voice/
│   │   │   ├── tools/
│   │   │   ├── settings/
│   │   │   ├── files/
│   │   │   ├── chat/
│   │   │   ├── nav/
│   │   │   └── cmd-palette/
│   │   ├── spaces/                     # Space management
│   │   └── widgets/                    # Widget runtime helpers
│   └── index.html
├── server/                             # Thin backend
│   ├── src/
│   │   ├── api/                        # REST API routes
│   │   ├── crdt/                       # WebSocket CRDT sync
│   │   ├── voice/                      # STT/TTS (keep existing)
│   │   └── proxy/                      # CORS proxy, LLM proxy
│   └── package.json
├── packages/shared/                    # Shared types
└── docs/
    └── TITAN_2_OVERHAUL.md             # This document
```

---

## 9. Success Criteria

TITAN 3.0 is successful when:

1. A new user opens TITAN and sees an empty Canvas with a floating agent orb.
2. They type "Create a weather widget" and the agent spawns a working weather widget on the Canvas.
3. They say "Show me SOMA" and the SOMA consciousness orb expands into a widget.
4. They type "Open Command Post" and the Canvas rearranges to show agent controls.
5. They go offline, move a widget, go back online, and the move syncs.
6. Two users open the same space and see each other's widget moves in real-time.
7. All legacy TITAN features (SOMA, voice, tools, infra) are accessible as widgets.
8. The agent can modify its own widgets by emitting `_____javascript` or `_____react`.

---

*Drafted for TITAN 3.0. Ready to build.*
