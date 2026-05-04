# Context Tree

> ByteRover-style structured context for TITAN.
> Hierarchical breakdown of the project.

---

## TITAN Project Tree

```
TITAN (titan-agent v5.5.3)
├── Core
│   ├── src/cli/index.ts          → CLI entry point
│   ├── src/agent/                → Agent runtime
│   │   ├── agent.ts              → Main agent loop
│   │   ├── orchestrator.ts       → Multi-agent orchestration
│   │   ├── subAgent.ts           → Sub-agent spawning
│   │   ├── reflection.ts         → Self-reflection
│   │   └── goals.ts              → Goal management
│   ├── src/gateway/              → Mission Control web UI
│   │   └── server.ts             → Gateway server
│   └── src/skills/               → 143 skills, 253 tools
│       ├── registry.ts           → Skill registry
│       └── builtin/              → Built-in skills
├── Providers
│   └── src/providers/            → 37 LLM providers
├── Channels
│   └── src/channels/             → 16 chat adapters
├── Safety
│   └── src/safety/               → Scanners, checkpoints, kill switch
├── Memory
│   └── src/memory/               → Persistent memory/graph
├── Infrastructure
│   ├── src/mesh/                 → Multi-instance networking
│   ├── src/organism/             → SOMA homeostatic drives
│   └── src/mcp/                  → MCP server mode
├── UI
│   ├── ui/                       → React Mission Control dashboard
│   └── titan-voice-ui/           → Voice UI
├── Tests
│   └── tests/                    → 249 test files, ~6600 tests
└── Docs
    ├── README.md
    ├── ARCHITECTURE.md
    ├── docs/                       → Additional documentation
    └── docs/agent-memory/          → KIMI-COO memory (new)
```

## Machine Tree

```
Development Environment
├── MacBook (Local)
│   ├── ~/Desktop/TitanBot/TITAN-main    → Dev workspace
│   ├── ~/Desktop/titan-synapse          → Model architecture (Rust/Python)
│   ├── ~/Desktop/TITAN.wiki             → GitHub wiki
│   ├── ~/.titan                         → Local runtime data
│   ├── ~/.gitnexus                      → GitNexus index (TITAN-main)
│   └── ~/.kimi_openclaw/workspace       → OpenClaw/Kimi workspace
│
└── Titan PC (Remote)
    ├── /opt/TITAN                       → ⭐ LIVE PRODUCTION
    ├── ~/titan                          → Runtime data (no git)
    ├── ~/titan-publish                  → Published v5.5.3 snapshot
    ├── ~/titan-saas                     → SaaS dashboard (Next.js)
    ├── ~/titan-synapse                  → Model architecture
    ├── ~/workspace/titanbot             → Python bot workspace
    ├── ~/.titan                         → Massive runtime (logs, checkpoints)
    ├── ~/.gitnexus                      → GitNexus index (/opt/TITAN)
    └── titan.service                    → Systemd service (live)
```

## Git Tree

```
origin/main
├── MacBook: 95fbb07 (handoff doc) ← 1 commit AHEAD
│
└── Titan PC: 7c3bfc16 (v5.5.3) ← same as origin/main
    └── titan-publish: HEAD detached at v5.5.3
```

## Memory Tree

```
Agent Memory
├── KIMI_COO_STATE.md              → Root operational memory
└── docs/agent-memory/
    ├── README.md                  → Index
    ├── current-state.md           → Active mission
    ├── commands.md                → Verified commands
    ├── known-issues.md            → Bugs and risks
    ├── decisions.md               → Tony-approved decisions
    ├── reflections.md             → Failure → rule
    ├── skills-candidates.md       → Repeated workflows
    └── context-tree.md            → This file
```

---

*Last updated: 2026-05-03 by KIMI-COO 🧠*
