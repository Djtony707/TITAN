# TITAN Architecture & Threat Model

## Overview

TITAN (The Intelligent Task Automation Network) is a secure, proactive AI agent platform built in Rust with a cognitive loop architecture.

## Philosophy

- **Secure by Default**: Workspace sandboxing, capability-based permissions
- **Proactive**: Agents observe, predict, and act without constant prompting
- **Transparent**: All actions traced, explainable, and reversible
- **Modular**: Skills are untrusted WASM modules with strict capability controls

---

## Architecture Components

### 1. Core Runtime (titan-core)

The cognitive loop engine:

```
┌─────────────────────────────────────────────────────────────┐
│                      COGNITIVE LOOP                          │
├─────────────────────────────────────────────────────────────┤
│  PERCEIVE → REASON → PLAN → ACT → OBSERVE → REFLECT → LEARN │
└─────────────────────────────────────────────────────────────┘
```

- **Perceive**: Event ingestion (Discord, schedule, file watchers)
- **Reason**: Goal extraction, priority assessment, context loading
- **Plan**: Task decomposition, tool selection, dependency resolution
- **Act**: Tool execution with permission checks
- **Observe**: Result validation, state changes, outcome recording
- **Reflect**: Success/failure analysis, strategy adjustment
- **Learn**: Memory consolidation, pattern extraction

### 2. Memory System (titan-memory)

SQLite-based tiered memory:

- **Working Memory**: Active context, conversation history, current goals
- **Episodic Memory**: Task execution traces, outcomes, timestamps
- **Semantic Memory**: Facts, concepts, learned patterns
- **Procedural Memory**: Skill usage patterns, effective strategies

Consolidation triggers:
- After task completion
- Scheduled (daily/hourly)
- Memory pressure (working memory full)

### 3. Tool System (titan-tools)

Capability-classified tools:

**Class A - Read-Only (Auto-approve in Collaborative mode)**
- `list_dir`
- `read_file`
- `search_text`
- `git_status`
- `git_diff`

**Class B - Write (Require approval)**
- `write_file`
- `git_commit`
- `git_push`

**Class C - Execute (Require approval)**
- `run_command`
- `execute_script`

**Class D - Network (Require approval)**
- `http_get`
- `http_post`
- `api_call`

All tool calls produce immutable trace records.

### 4. Skill System (titan-skills)

Untrusted WASM modules:

- **Manifest**: `manifest.toml` with name, version, capabilities, entry point
- **Binary**: `.wasm` compiled with WASI target
- **Sandbox**: wasmtime with capability-based restrictions
- **No secrets access**: Skills cannot read ~/.titan/config or env vars
- **Workspace restriction**: Skills can only access workspace directory
- **Network**: Disabled by default, opt-in per skill

Skill capabilities declared:
```toml
[capabilities]
filesystem = ["read", "write"]
network = false
environment = []
```

### 5. Discord Integration (titan-discord)

Serenity-based bot:

- Message reception and parsing
- Goal extraction from natural language
- Typing indicators during processing
- Embedded responses with approval buttons
- DM and guild channel support
- Role-based permissions

### 6. Web Dashboard (titan-web)

Axum-based local UI:

- Real-time mode switching
- Goal queue visualization
- Approval request management
- Memory exploration (searchable, filterable)
- Execution traces (timeline view)
- System health metrics

---

## Threat Model

### Assets

1. User workspace (source code, documents)
2. User secrets (API keys, credentials)
3. System resources (CPU, network, filesystem)
4. Agent memory (learned patterns, potentially sensitive)

### Threats

| Threat | Vector | Mitigation |
|--------|--------|------------|
| Malicious skill | WASM module with hidden payload | Sandboxing, capability model, no secret access |
| Prompt injection | User message tricks agent | Input sanitization, approval gates for write/exec |
| Workspace escape | Tool breaks out of workspace | Path canonicalization, chroot-like restrictions |
| Secret exfiltration | Agent sends keys to attacker | Secrets isolated in ~/.titan/, no env var access for skills |
| Unauthorized actions | Agent modifies files without consent | Autonomy modes, approval workflow, traces |
| Resource exhaustion | Infinite loop or expensive operation | Timeout enforcement, rate limiting, resource quotas |
| Memory poisoning | Attacker manipulates learned patterns | Memory validation, source attribution, manual review |

### Trust Boundaries

```
[User] → [Discord/CLI] → [TitanBot] → [Tools/Skills]
              ↑              ↑              ↑
         Trusted         Trusted        Untrusted
         (Verified)      (Verified)     (Sandboxed)
```

---

## Autonomy Modes

### Supervised
- All actions require explicit approval
- Maximum security, minimal convenience
- For critical/irreversible operations

### Collaborative (Default)
- Read actions auto-approved
- Write/exec/network require approval
- Balance of safety and productivity

### Autonomous
- Allowlist of pre-approved patterns
- High-trust scenarios only
- Full traceability and rollback capability

---

## Data Flow

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ Discord │───→│Perceiver│───→│ Reasoner│───→│ Planner │
│  Event  │    │         │    │         │    │         │
└─────────┘    └─────────┘    └─────────┘    └─────────┘
                                                  │
                         ┌──────────────────────┘
                         ↓
                   ┌─────────┐    ┌─────────┐
                   │  Actor  │───→│  Tool   │
                   │         │    │ Executor│
                   └─────────┘    └─────────┘
                         │
                         ↓
                   ┌─────────┐    ┌─────────┐
                   │Observer │───→│ Reflector│
                   │         │    │          │
                   └─────────┘    └─────────┘
                         │
                         ↓
                   ┌─────────┐
                  │  Learn  │
                   │         │
                   └─────────┘
```

---

## Implementation Phases

### Phase 1: Foundation
- [ ] Cargo workspace setup
- [ ] Core types and traits
- [ ] SQLite schema
- [ ] Configuration system

### Phase 2: Memory & Tools
- [ ] Working memory implementation
- [ ] Episodic storage
- [ ] Tool registry
- [ ] Permission engine

### Phase 3: Cognitive Loop
- [ ] Perceiver (events)
- [ ] Reasoner (goal extraction)
- [ ] Planner (task decomposition)
- [ ] Actor (execution)
- [ ] Observer (validation)
- [ ] Reflector (analysis)
- [ ] Learner (consolidation)

### Phase 4: Discord
- [ ] Serenity bot setup
- [ ] Message handling
- [ ] Approval flow
- [ ] Status display

### Phase 5: Skills
- [ ] WASI runtime (wasmtime)
- [ ] Manifest parser
- [ ] Capability enforcement
- [ ] Basic skill examples

### Phase 6: Web UI
- [ ] Axum server
- [ ] Dashboard frontend
- [ ] Approval interface
- [ ] Memory browser

### Phase 7: Polish
- [ ] Tests
- [ ] Documentation
- [ ] Demo tasks
- [ ] Final delivery

---

## Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | Rust | Memory safety, performance, WASM support |
| Database | SQLite | Embedded, zero-config, portable |
| Discord | Serenity | Mature, async, Rust-native |
| Web | Axum | Tokio-based, ergonomic, performant |
| Sandbox | wasmtime | Official WASI runtime, capability model |
| Config | TOML | Human-readable, standard for Rust |
| Secrets | .env + filesystem | Simple, works with systemd |

---

## File Structure

```
/home/$USER/Desktop/TITAN/
├── Cargo.toml              # Workspace root
├── README.md
├── LICENSE
├── THIRD_PARTY_NOTICES.md
├── crates/
│   ├── titan-cli/          # CLI entrypoint and command handlers
│   ├── titan-common/       # Shared config/logging/path guard
│   ├── titan-comms/        # Multi-channel communication adapters
│   ├── titan-core/         # Cognitive loop, types
│   ├── titan-memory/       # SQLite memory system
│   ├── titan-tools/        # Tool implementations
│   ├── titan-skills/       # WASM skill host
│   ├── titan-discord/      # Discord bot
│   ├── titan-gateway/      # Gateway abstractions
│   └── titan-web/          # Axum dashboard
├── docs/
│   ├── ONBOARDING.md
│   ├── API.md
│   ├── TITAN_COMMUNICATION_INTEGRATIONS.md
│   └── architecture.md
├── scripts/
│   ├── copy-risk-check.sh
│   ├── release-check.sh
│   └── security-check.sh
└── research/
```

---

## Success Criteria

1. `cargo test` passes (unit + integration + security)
2. Discord bot responds to messages
3. Three demo tasks execute successfully
4. All tools produce traces
5. Skills run in WASM sandbox
6. Web dashboard shows status
7. Memory persists across restarts
8. Approval workflow functions
9. No slop in code (linted, formatted, documented)
