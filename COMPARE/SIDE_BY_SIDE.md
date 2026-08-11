# SIDE_BY_SIDE.md — TITAN v7 vs v8, Screen by Screen

Method: v7 evidence from source (v7.2.1). v8 evidence from mockups at `COMPARE/mockups/` + the v8 architecture.

---

## Screen 1: The Landing Page (Home)

### v7 — TitanCanvas
- Customizable desk with "Ask TITAN" hero as a widget
- Spaces sidebar on the left (create/activate/archive)
- Mascot roams free, nudges setup if no model configured
- A solo experience: you + one agent, no crew visible

### v8 — The Update Moment → Company Room
- First-run-after-update: the crew introduces itself citing the user's real v7 history ("you ran deep_research 47 times this year")
- The seed stats banner: 164 skills, 847 memories, 2.3 years of history retrievable via governed access
- After the intro, the default surface IS the Company Room — a persistent flat chat with the crew working in it
- The mascot still roams. The desk is still wood. The sidebar is still 5 doors.

### What changed
The default surface went from a solo desk to a room with people in it. The first thing you see after updating is your crew already knowing you — seeded from your v7 history.

### What stayed (soul clause)
- The wood desk, the mascot, the warm serif palette — unchanged (same CSS values from DeskSurface.tsx)
- The 5-door sidebar — same names, same order
- The "Ask TITAN" hero is still there as a widget if you want it (Desk → Space → Home)
- Every v7 route still resolves (12 legacy redirects preserved)

### Why v8 is better
The owner's #1 like: "I like chatting with all of them and them actually working together." v7's home is a desk for one. v8's home is a room with a crew. The cockpit is still there — one click away. Same family, best year.

---

## Screen 2: The Chat Experience

### v7 — Mission Chat (1:1)
- Mission-scoped: MissionStart → create a mission → MissionChat
- One conversation per mission, one agent at a time
- ToolCallIndicator and ToolInvocationTimeline show what the agent is doing
- No persistent multi-agent room; agents don't talk to each other where the user can see

### v8 — The Company Room (flat, multi-agent)
- Persistent flat channel per project — no threads, ever
- The CEO runs the work queue; agents pick up, report, hand off — all visible top-level
- Growth moments surface inline (illustrative mockup copy): "Forge learned: v7's token burn is ~12,000 per reply"
- Presence rail on the right: who's active, who's thinking, who's idle, current task, mood
- Today's growth summary at the bottom of the rail: 3 compiled, 12 learned, $23.40 saved
- Hire button in the header: + Hire → 5-question interview → born, not configured

### What changed
1:1 mission chat → multi-agent company room. The user watches the crew work together instead of talking to one agent at a time. Growth is visible inline — you see skills being compiled as they happen.

### What stayed
- ChatInput, MessageBubble, streaming, tool indicators — the chat components carry forward (same `ui/src/components/chat/` directory)
- The CLI is still the escape hatch (`⌘K to command` in the header)

### Why v8 is better
v7's chat is a tool. v8's chat is a workplace. The difference is watching your crew argue, self-correct, hand off, and learn — in one readable room — instead of driving one agent at a time.

---

## Screen 3: Team / Crew

### v7 — Agents + Org Chart + Personas (admin panels)
- `CPAgents`: agent list with model, status, budget
- `CPOrg`: org chart view
- `PersonasPanel`: persona management
- No presence, no mood, no growth feed, no "born-not-configured"
- Agents are configured, not born — you set them up manually

### v8 — The Crew (living agent cards)
- 8 agent cards with: presence dot (active/thinking/busy/idle), current task, mood, growth feed
- Each card shows: name, role, status, current work, "Compiled N skills · Xk tokens saved"
- Hire card: dashed border, "+ Hire a new agent" → 5-question interview → born, not configured
- The Company Brain panel: 142 shared memories, 11 compiled skills (shared), $23.40 saved, 8 voices one brain
- Every agent has its own memory stream; all streams pool into one shared brain

### What changed
- Static admin panel → living crew page. Agents have presence, mood, growth, and a shared brain.
- Configuration → interview. Born, not configured.
- 1:1 identity → one brain, many voices

### What stayed
- The "Team" concept, the org chart (still accessible via a button), the persona system (now persona PACKS — versioned, diffable)
- `CPAgents` and `CPOrg` still exist under Workshop for power users

### Why v8 is better
The owner's ask: "they should feel real." v7's team page is a config table. v8's crew page is a team you can feel. You see who's working, what they're doing, what they've learned — and you can hire someone new in a 5-question interview.

---

## Screen 4: Memory / Knowledge

### v7 — 7 admin panels under Knowledge
- Memory Graph, Memory Taxonomy, Wiki, Autoresearch, Self-Improve, Dreams, Training
- Each is a separate panel; the user navigates between them
- Memory is the agent's — there's no concept of shared company memory across agents

### v8 — Growth Moments (the joy layer)
- Every compiled skill, every lesson learned, every dollar saved → one visible feed
- Each growth card has: type (compiled/learned/saved), who did it, provenance (trace IDs, source), tokens saved, state (shadow/active), whether it's shared
- The company brain is one shared pool — a lesson learned by one agent is available to all
- Compiled skills are shared memories: "Sage's traces taught the company X"

### What changed
7 separate admin panels → one feed of visible growth. The engine's work (compilation, learning, saving) becomes visible and tangible. Memory went from per-agent to one brain, many voices.

### What stayed
- The Memory Graph, Wiki, Dreams, Training panels still exist under Workshop
- The graphiti temporal knowledge graph (already in v7) is the relationship layer for the shared brain
- Procedural memory (`src/skills/proceduralMemory.ts`) is still there — now it feeds the compiler

### Why v8 is better
v7 hides its own intelligence. The self-compiling engine, the procedural memory, the GEPA evolution — all invisible. v8 makes growth visible (illustrative mockup copy): "Loom compiled: 'summarize file' → zero-frontier-call recipe. 12,000 tokens saved." That's the likeable mandate made tangible. You watch your TITAN get smarter.

---

## Screen 5: Dashboard / Management

### v7 — Command Post (11 sub-panels)
- CPDashboard, CPIssues, CPApprovals, CPActivity, CPGoals, CPRuns, CPAgents, CPOrg, CPFiles, CPVoice, CPCosts
- Gated behind `commandPost.enabled` — if off, shows "not active yet"
- A management cockpit: issues, approvals, activity, goals, runs, costs — all separate views
- No "one glance" view; you navigate between panels

### v8 — The Dashboard (one glance, one verb: decide)
- 4 stat cards: 7 agents active, $23.40 saved, 11 skills compiled, 142 tasks ran locally
- What's Alive Right Now: each agent + current task + time in (with pulse dots)
- What's Stuck: blocked items with red pulse + workaround status
- The Next Decision: the one thing the human must act on (2 approvals pending → Approve/Review buttons)
- compiler status: terminal-style output (142 compiled, 61% local, tokens/task down 78%, $23.40 saved)

### What changed
11 management panels → one decision surface. The watchman's view: who's alive, who's stuck, what's the next decision. One glance, one verb — decide.

### What stayed
- Every Command Post panel still exists under Workshop (Issues, Approvals, Activity, Goals, Runs, Agents, Org, Files, Voice, Costs)
- The dashboard surfaces the same data, just aggregated — the panels are the detail drill-down
- `commandPost.enabled` gate still applies; the dashboard respects it

### Why v8 is better
The owner doesn't want to manage. He wants to decide. v7's Command Post is a cockpit with 11 screens. v8's dashboard answers the three questions a human actually asks: what's alive, what's stuck, what do I need to decide. The cockpit is still there for when you want it.

---

## Screen 6: The Update Moment (new in v8)

### v7 — No equivalent
v7 updates via `titan update` (CLI). The user runs the update, the version bumps, the dashboard reloads. No ceremony, no introduction, no sense of meeting something new.

### v8 — First-Run-After-Update
- Hero banner: "Welcome back, Jordan. Your TITAN just grew up."
- Progress steps: Backup created ✓ → Config migrated ✓ → v7 history searchable ✓ → Meet your crew (current)
- Seed stats: 164 skills, 847 memories searchable, 2.3 years of history retrievable
- Crew introduces itself via governed retrieval (not inheritance), each citing v7 history with provenance:
  - Atlas: "you ran deep_research 47 times this year" (Source: v7 skill logs)
  - Forge: "recurring tasks that cost significant tokens — I've compiled 11 skills" (Source: v7 receipt logs)
  - Sage: "3 skills published with failing tests — flagged" (Source: v7 audit logs)
  - Sentinel: "read-only commands started schedulers — fixed in v8" (Source: v7 session logs)
  - Loom: "gateway running since Jul 27 — won't touch it" (Source: v7 gateway status)
- Rollback control: visible backup ID + verification status; migration's automatic rollback (via v7's checkpoint manager) restores v7 from the pre-migration backup
- CTA: "Open the Company Room →" with rollback reassurance

### What changed
A version bump became an introduction. The user meets their crew, and the crew can search their history — because the company brain has governed retrieval access to the user's v7 traces, skills, and memories with full provenance. Agents retrieve authorized, attributed history; they do not inherit it as personal memory. This is the product-gold fusion: One-Brain + Upgrade = your first hire can search everything your TITAN ever did for you.

### What stayed
- The update mechanism is v7's own (`titan update` + `src/checkpoint/manager.ts` migrate/backup/smoke-check/auto-rollback)
- Every v7 config carries forward: titan.json, skills, memories, recipes, vault, gateway
- Rollback: the migration includes automatic rollback via v7's own checkpoint manager (`src/checkpoint/manager.ts`). Pre-migration backup is preserved and can be restored.

### Why v8 is better
This is the moment the owner judges. A one-click update that doesn't just bump a version — it introduces a crew that already knows you. The same soul (TITAN, the desk, the CLI, the mascot) with a new wing (the company, the brain, the engine). "TITAN having its best year."

---

## Soul Clause Receipts (the 10-second test)

| v7 element | In v8? | Where |
|-----------|--------|-------|
| The name "TITAN" | ✓ | Sidebar logo, every screen |
| The wood desk (oak/walnut/mahogany/white) | ✓ | Body background, same CSS values |
| The roving mascot | ✓ | Fixed bottom-right, every screen |
| The 5-door sidebar (Home/Desk/Studio/Memory/Workshop) | ✓ | Same labels, same order |
| The warm serif (#c4b49a / #f3d27a) | ✓ | Same palette tokens |
| The CLI (`titan doctor`, `titan gateway`, etc.) | ✓ | Still works, additive |
| `titan update` | ✓ | Delivers v8, one click |
| 164 skills | ✓ | Carried forward, 11 already compiled |
| Procedural memory | ✓ | Feeds the compiler |
| Graphiti knowledge graph | ✓ | Relationship layer for the company brain |
| Mission chat | ✓ | Still at `/missions`, under Workshop |
| 31 admin panels | ✓ | All under Workshop, all still work |
| 12 legacy route redirects | ✓ | All preserved |
| Model-agnostic | ✓ | Local-first, any LLM |
| Local-first | ✓ | No external services required |

**10-second test:** a v7 user opens v8 and sees the same TITAN — same desk, same sidebar, same mascot, same CLI. But the home screen is a room with people in it, not a desk for one. Same family, best year.
