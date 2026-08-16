# CURRENT.md — TITAN v7.2.1 GUI Inventory

<!-- Release hygiene: all evidence cited from v7.2.1 source files. No private user data, real customer information, or measured production metrics are included. Any illustrative examples are labeled as such. -->

Evidence: source read from the v7 codebase (v7.2.1).
Every claim below cites a real source file. ASSUMPTION vs MEASUREMENT marked.

## The Shell

TITAN v7's UI is a React SPA served by the gateway (`src/gateway/server.ts`), wrapped in a **5-door sidebar** (`ui/src/components/shell/TitanShell.tsx`):

| Door | Route | What it is |
|------|-------|-----------|
| Home | `/` | TitanCanvas — the customizable desk, "Ask TITAN" hero as a widget, mascot roams free |
| Desk | `/space/home` | Canvas spaces (persisted in `~/.titan/spaces.json`), left rail lists spaces |
| Studio | `/studio` | Live Studio — watch the agent work in real time |
| Memory | `/memory` | AboutYouMemory — the agent's memory of the user |
| Workshop | (dropdown) | The entire admin surface: 30+ panels in one menu |

MEASUREMENT: the sidebar has 5 top-level items + 1 expandable Workshop menu holding 28 destinations (counted from `TITAN_SHELL_SECTIONS` in TitanShell.tsx). The v7.0 comment calls it "likeable nav — 5 doors instead of 48 destinations."

## The Desk Surface

The entire app sits on a **wood-textured desk** (`ui/src/components/desk/DeskSurface.tsx`):
- 4 themes: oak (default), walnut, mahogany, white
- Wood grain via repeating linear gradients, window-glow via radial gradients, vignette, animated dust motes
- `#c4b49a` serif accents for loading text
- The mascot roams on top of the desk

MEASUREMENT: oak palette extracted from `THEMES.oak` in DeskSurface.tsx:
`base: ['#6e4724', '#5a3717', '#482a13']`, `text: '#f3e9d0'`, `accent: '#f3d27a'`, `border: '#8a6a3a'`, `paper: '#f7f5ee'`.

## Home (TitanCanvas)

The default landing page (`ui/src/titan2/canvas/TitanCanvas.tsx`):
- A customizable canvas with widgets ("Ask TITAN" hero is itself a widget)
- Spaces sidebar on the left (create/activate/archive spaces)
- The mascot nudges setup when no model is configured
- v7.0 redo: first run no longer blocks behind a 7-step wizard — users land on the desk immediately

## Chat (Mission-Scoped)

Chat in v7 is **mission-scoped**, not a persistent room (`ui/src/pages/MissionChat.tsx`, `ui/src/components/chat/`):
- `MissionStart` → creates a mission → `MissionChat` for the conversation
- Chat components: ChatView, MessageBubble, ChatInput, QuickActions, StreamingMessage, ToolCallIndicator, ToolInvocationTimeline
- There is no persistent multi-agent channel. The user talks to ONE agent per mission.

ASSUMPTION: the chat experience is 1:1 (user → agent), not multi-agent (crew → room). The command-post panels show agent activity, but agents do not talk to each other in a shared space the user can read.

## Command Post

The admin/management surface (`ui/src/components/command-post/`):
- CPDashboard, CPIssues, CPApprovals, CPActivity, CPGoals, CPRuns, CPAgents, CPOrg, CPFiles, CPVoice, CPCosts
- Gated behind `config.commandPost.enabled` — if off, shows a "Command Post is off" message
- This is the closest v7 gets to "a company" — but it's a dashboard, not a room

MEASUREMENT: the `CommandPostRoute` wrapper in App.tsx checks `cfg.commandPost?.enabled` and shows a "not active yet" message if disabled.

## The 30+ Admin Panels

Under Workshop, v7 ships an enormous admin surface (all in `ui/src/components/admin/`):

| Category | Panels |
|----------|--------|
| Team | Agents, Org Chart, Personas |
| Knowledge | Memory Graph, Memory Taxonomy, Wiki, Autoresearch, Self-Improve, Dreams, Training |
| Tools | Skills, Evals, Observability, MCP, Integrations, Channels, Mesh, Browser, Recipes, Files, Voice, Phone Desk |
| System | Settings, Security, Costs, Audit, Backup, Logs, Homelab, GPU, VRAM, Fleet, Cron, Quality Lab |

MEASUREMENT: 31 admin panels counted from App.tsx lazy imports + Workshop submenu in TitanShell.tsx.

## Legacy Routes

v7 keeps 12 legacy route redirects for muscle memory (App.tsx lines 189-199):
`/soma → /knowledge`, `/intelligence → /knowledge`, `/infra → /system`, `/settings → /system/settings`, `/watch → /missions/activity`, `/projects → /missions/work`, `/issues → /missions/issues`, `/goals → /missions/goals`, `/approvals → /missions/approvals`, `/activity → /missions/activity`, `/command-post/* → Command Post`, `/mission → /missions`.

## The Mascot

A roving pixel-art mascot (`ui/src/titan2/system/RovingMascot.tsx`) that wanders the desk, nudges setup on first run, and celebrates with fireworks (`ui/src/titan2/system/Fireworks.tsx`).

## Voice

Voice overlay (`ui/src/components/voice/VoiceOverlay.tsx`) and a voice UI app (`titan-voice-ui/`) — TITAN has a voice mode.

## What v7's GUI IS (the honest summary)

v7 is a **powerful cockpit** with a likeable skin. The desk and mascot make it warm; the 5-door sidebar keeps the nav simple; but the actual experience is: you open a mission, you talk to one agent, you manage things through 31 admin panels. There is no crew. There is no room. There is no visible growth. There is no company brain. The engine is there (skills, procedural memory, model trainer, GEPA) but it's invisible — you can't see TITAN learning. It's a tool, not a teammate.

**The owner's verdict ("TITAN is boring compared to a crew-based platform") is not about capability. It's about company and presence.** v7 has the parts; v8 assembles them into a crew you can watch work.
